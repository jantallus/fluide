const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin } = require('../middleware/auth');
const Stripe = require('stripe');
const { sendConfirmationEmail, sendConfirmationSMS, sendAdminNotificationEmail } = require('../services/email');
const { generatePDFBuffer, drawBackground } = require('../services/pdf');
const PDFDocument = require('pdfkit');
const { googleSyncCache } = require('../services/googleSync');
const { performBooking } = require('../services/booking');
const { processStripeSession } = require('../services/stripeProcessor');
const { generateICalFeed } = require('../services/ical');

// ── Rate limiters ──────────────────────────────────────────────────────────────

// Création de session Stripe (vol + bon cadeau) : max 8 tentatives / 15 min / IP
// Empêche le spam de sessions Stripe (coût + pollution dashboard)
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: { error: 'Trop de tentatives de paiement. Veuillez réessayer dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Confirmation de paiement : max 20 tentatives / 15 min / IP
// Empêche le bruteforce de session IDs Stripe
const confirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Trop de requêtes. Veuillez réessayer dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Disponibilités : max 60 requêtes / minute / IP (1/s en moyenne)
// Limite le scraping tout en laissant l'usage normal du tunnel de réservation
const availabilitiesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Trop de requêtes. Veuillez patienter un instant.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/api/public/availabilities', availabilitiesLimiter, async (req, res) => {
  const { start, end } = req.query; 
  try {
    if (!start || !end) return res.status(400).json({ error: "Période requise" });
    
    // 1. Un seul appel pour récupérer la grille de la base de données
    const r = await pool.query(`SELECT id, start_time, end_time, status, monitor_id FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 ORDER BY start_time ASC`, [start, end]);
    let slots = r.rows;

    const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
    const isGoogleSyncEnabled = syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true';

    if (isGoogleSyncEnabled) {
      // 2. On lit simplement la RAM du serveur (0.001 seconde d'attente)
      // Utilise un vrai test de chevauchement (identique au planning admin) :
      // un créneau est bloqué si N'IMPORTE QUELLE partie de ce créneau tombe dans l'événement Google.
      // L'ancienne logique (slotStart >= g.start) manquait les créneaux qui COMMENCENT avant
      // l'événement mais se TERMINENT pendant celui-ci (ex: créneau 12h20-12h35 vs event 12h30-13h00).
      slots = slots.map(slot => {
        if (slot.status === 'available' && slot.monitor_id) {
          const googleBusySlots = googleSyncCache.get(slot.monitor_id) || [];
          const slotStart = new Date(slot.start_time).getTime();
          const slotEnd = new Date(slot.end_time).getTime();
          const isBusy = googleBusySlots.some(g => slotStart < g.end && slotEnd > g.start);
          if (isBusy) return { ...slot, status: 'booked' };
        }
        return slot;
      });
    }

    res.json(slots);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/api/public/site-settings', async (req, res) => {
  try {
    const r = await pool.query("SELECT key, value FROM site_settings WHERE key IN ('physical_gift_card_enabled', 'physical_gift_card_price')");
    const settings = r.rows.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/// 🎯 SECURISE : CREATION SESSION STRIPE BON CADEAU
router.post('/api/public/checkout-gift-card', checkoutLimiter, async (req, res) => {
  const { template, buyer, physicalShipping, selectedComplements } = req.body;
  try {
    // 🛡️ SÉCURITÉ : On ne fait jamais confiance aux prix envoyés par le client.
    // On utilise uniquement template.id pour aller chercher le vrai prix en base.
    const templateId = template?.id;
    if (!templateId) return res.status(400).json({ error: 'Template ID manquant.' });

    const tplRes = await pool.query(
      'SELECT * FROM gift_card_templates WHERE id = $1 AND is_published = true',
      [templateId]
    );
    const tpl = tplRes.rows[0];
    if (!tpl) return res.status(400).json({ error: 'Modèle de bon cadeau introuvable ou non publié.' });

    const shipRes = await pool.query("SELECT value FROM site_settings WHERE key = 'physical_gift_card_price'");
    const shipPriceCents = shipRes.rows.length > 0 ? (parseInt(shipRes.rows[0].value) || 0) * 100 : 0;

    // Prix du bon cadeau — lu depuis la DB, pas depuis le client
    const line_items = [{
      price_data: {
        currency: 'eur',
        product_data: { name: tpl.title, description: `Bon cadeau offert par : ${buyer.name}` },
        unit_amount: tpl.price_cents
      },
      quantity: 1
    }];

    // Options (compléments) — on ne fait confiance qu'aux IDs, prix relus depuis la DB
    let optionsTotalCents = 0;
    let optionsText = '';
    if (selectedComplements && selectedComplements.length > 0) {
      const names = [];
      for (const comp of selectedComplements) {
        const compRes = await pool.query(
          'SELECT name, price_cents FROM complements WHERE id = $1 AND is_active = true',
          [comp.id]
        );
        const dbComp = compRes.rows[0];
        if (!dbComp) return res.status(400).json({ error: `Option introuvable ou désactivée (id: ${comp.id})` });

        optionsTotalCents += dbComp.price_cents;
        names.push(dbComp.name);
        line_items.push({
          price_data: {
            currency: 'eur',
            product_data: { name: `Option incluse : ${dbComp.name}` },
            unit_amount: dbComp.price_cents
          },
          quantity: 1
        });
      }
      optionsText = `Options incluses : ${names.join(', ')}\n`;
    }

    if (physicalShipping && physicalShipping.enabled && shipPriceCents > 0) {
      line_items.push({
        price_data: {
          currency: 'eur',
          product_data: { name: "📮 Envoi Postal", description: "Carte glacée imprimée envoyée par courrier" },
          unit_amount: shipPriceCents
        },
        quantity: 1
      });
    }

    const sessionConfig = {
      payment_method_types: ['card'],
      customer_email: buyer.email,
      line_items: line_items,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/succes?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/bons-cadeaux`,
      metadata: {
        purchase_type: 'gift_card',
        buyer_name: String(buyer.name || 'Client Inconnu').substring(0, 499),
        buyer_email: String(buyer.email || '').substring(0, 499),
        buyer_phone: String(buyer.phone || '').substring(0, 499),
        price_paid_cents: String(tpl.price_cents + optionsTotalCents),
        validity_months: String(tpl.validity_months || 12),
        flight_type_id: String(tpl.flight_type_id || ''),
        pdf_background_url: String(tpl.pdf_background_url || '').substring(0, 499),
        buyer_address: physicalShipping?.enabled ? String(physicalShipping.address).substring(0, 499) : '',
        notes: String(optionsText).substring(0, 499),
        custom_line_1: String(tpl.custom_line_1 || '').substring(0, 80),
        custom_line_2: String(tpl.custom_line_2 || '').substring(0, 80),
        custom_line_3: String(tpl.custom_line_3 || '').substring(0, 80)
      }
    };

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur Checkout Stripe Cadeau:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/public/checkout', checkoutLimiter, async (req, res) => {
  const { contact, passengers, voucher_code } = req.body;

  // Limite configurable depuis le backoffice (clé : max_passengers_per_booking, défaut : 8)
  if (!Array.isArray(passengers) || passengers.length === 0) {
    return res.status(400).json({ error: 'Liste de passagers invalide.' });
  }
  const maxPassSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'max_passengers_per_booking'");
  const maxPassengers = maxPassSetting.rows.length > 0 ? (parseInt(maxPassSetting.rows[0].value) || 8) : 8;
  if (passengers.length > maxPassengers) {
    return res.status(400).json({ error: `Maximum ${maxPassengers} passagers par réservation.` });
  }

  const client = await pool.connect();

  try {
    let flightTotalCents = 0;
    let complementsTotalCents = 0;
    const line_items = [];

    for (const p of passengers) {
      // On vérifie que le vol existe ET est actif — rejette les IDs invalides ou désactivés
      const flightRes = await client.query('SELECT name, price_cents FROM flight_types WHERE id = $1 AND is_active = true', [p.flightId]);
      const flight = flightRes.rows[0];
      if (!flight) {
        return res.status(400).json({ error: `Type de vol introuvable ou désactivé (id: ${p.flightId})` });
      }
      flightTotalCents += flight.price_cents;
      line_items.push({
        price_data: { currency: 'eur', product_data: { name: `Vol ${flight.name}`, description: `Passager: ${p.firstName} - Le ${p.date} à ${p.time}` }, unit_amount: flight.price_cents }, quantity: 1
      });

      if (p.selectedComplements && p.selectedComplements.length > 0) {
        for (const compId of p.selectedComplements) {
          const compRes = await client.query('SELECT name, price_cents FROM complements WHERE id = $1 AND is_active = true', [compId]);
          const comp = compRes.rows[0];
          if (!comp) {
            return res.status(400).json({ error: `Option introuvable ou désactivée (id: ${compId})` });
          }
          complementsTotalCents += comp.price_cents;
          line_items.push({
            price_data: { currency: 'eur', product_data: { name: `Option: ${comp.name} (pour ${p.firstName})` }, unit_amount: comp.price_cents }, quantity: 1
          });
        }
      }
    }

    let originalPriceCents = flightTotalCents + complementsTotalCents;
    let discountAmountCents = 0;
    let appliedVoucher = null;

    if (voucher_code) {
      const vRes = await client.query(`SELECT * FROM gift_cards WHERE UPPER(code) = UPPER($1) AND status = 'valid'`, [voucher_code]);
      if (vRes.rows.length > 0) {
        appliedVoucher = vRes.rows[0];
        if (appliedVoucher.type === 'gift_card') {
          discountAmountCents = appliedVoucher.price_paid_cents;
        } else if (appliedVoucher.type === 'promo') {
          const scope = appliedVoucher.discount_scope || 'both';
          let targetAmountCents = originalPriceCents;
          
          if (scope === 'flight') targetAmountCents = flightTotalCents;
          if (scope === 'complements') targetAmountCents = complementsTotalCents;

          if (appliedVoucher.discount_type === 'fixed') discountAmountCents = Math.min(appliedVoucher.discount_value * 100, targetAmountCents);
          if (appliedVoucher.discount_type === 'percentage') discountAmountCents = Math.round(targetAmountCents * (appliedVoucher.discount_value / 100));
        }
      }
    }

    const finalPriceCents = Math.max(0, originalPriceCents - discountAmountCents);

    if (finalPriceCents === 0) {
      await client.query('BEGIN');
      let pData = null;
      if (appliedVoucher) {
        pData = { voucher: originalPriceCents, code: appliedVoucher.code, code_type: appliedVoucher.type };
      }
      await performBooking(client, contact, passengers, pData);
      
      if (appliedVoucher) {
        await client.query(`UPDATE gift_cards SET current_uses = current_uses + 1, status = CASE WHEN max_uses IS NOT NULL AND (current_uses + 1) >= max_uses THEN 'used' ELSE status END WHERE id = $1`, [appliedVoucher.id]);
      }
      
      await client.query('COMMIT');
      
      if (passengers.length > 0) {
        const firstPass = passengers[0];
        const flightDateObj = new Date(firstPass.date);
        const beautifulDate = flightDateObj.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
        await sendConfirmationEmail(contact.email, `${contact.firstName} ${contact.lastName}`, 'flight', firstPass.flightName, beautifulDate, firstPass.time, firstPass.flightId);
        await sendConfirmationSMS(contact.phone, contact.firstName, 'flight', beautifulDate, firstPass.time, firstPass.flightId);
        await sendAdminNotificationEmail(`${contact.firstName} ${contact.lastName}`, contact.phone, firstPass.flightName, beautifulDate, firstPass.time);
      }
      return res.json({ url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/succes?session_id=GRATUIT_${Date.now()}` });
    }

    const passengersJson = JSON.stringify(passengers);
    const metadata = {
      contact_name: `${contact.firstName} ${contact.lastName}`.substring(0, 500),
      contact_phone: contact.phone ? String(contact.phone).substring(0, 500) : '',
      contact_email: contact.email ? String(contact.email).substring(0, 500) : '',
      contact_notes: contact.notes ? contact.notes.substring(0, 450) : '',
      voucher_code: appliedVoucher ? appliedVoucher.code : '',
      voucher_type: appliedVoucher ? appliedVoucher.type : '',
      voucher_discount_cents: discountAmountCents ? discountAmountCents.toString() : '0'
    };

    const chunkSize = 500;
    for (let i = 0; i < passengersJson.length; i += chunkSize) {
      metadata[`passengers_chunk_${Math.floor(i / chunkSize)}`] = passengersJson.substring(i, i + chunkSize);
    }

    const sessionConfig = {
      payment_method_types: ['card'],
      customer_email: contact.email,
      line_items: line_items,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/succes?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/booking`,
      metadata: metadata 
    };

    if (appliedVoucher && discountAmountCents > 0) {
      const coupon = await stripe.coupons.create({ amount_off: discountAmountCents, currency: 'eur', duration: 'once', name: `Réduction (${appliedVoucher.code})` });
      sessionConfig.discounts = [{ coupon: coupon.id }];
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Erreur Checkout Stripe:", err);
    res.status(500).json({ error: "Erreur lors de l'initialisation du paiement." });
  } finally {
    client.release();
  }
});

// 🎯 SECURISE : CONFIRMATION DES PAIEMENTS (chemin redirect)
// Verrou mémoire — protection rapide contre les doubles appels concurrents
// (ex : React StrictMode appelle useEffect deux fois en dev).
// La protection principale contre les redémarrages/multi-instances est dans
// processStripeSession() via la table stripe_payments.
const activeCheckoutSessions = new Set();

router.post('/api/public/confirm-booking', confirmLimiter, async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: "Session ID manquant" });

  // Les paiements gratuits sont traités en amont — rien à confirmer ici
  if (session_id.startsWith('GRATUIT_')) return res.json({ success: true });

  // 🔒 Verrou mémoire : bloque les requêtes concurrentes sur la même instance
  if (activeCheckoutSessions.has(session_id)) {
    console.log("🛡️ Doublon concurrent bloqué (verrou mémoire) :", session_id);
    return res.json({ success: true, message: "Achat déjà en cours de traitement" });
  }
  activeCheckoutSessions.add(session_id);
  setTimeout(() => activeCheckoutSessions.delete(session_id), 3600000);

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      activeCheckoutSessions.delete(session_id);
      return res.status(400).json({ error: "Le paiement n'a pas abouti." });
    }

    // processStripeSession gère l'idempotence DB et tout le traitement
    const result = await processStripeSession(session);

    if (result === null) {
      // Déjà traité (par un webhook ou un appel précédent) — on relit le résultat
      const stored = await pool.query(
        'SELECT type, result_code FROM stripe_payments WHERE session_id = $1',
        [session_id]
      );
      const row = stored.rows[0];
      if (row?.type === 'gift_card') {
        return res.json({ success: true, is_gift_card: true, code: row.result_code });
      }
      return res.json({ success: true });
    }

    return res.json(result);

  } catch (err) {
    activeCheckoutSessions.delete(session_id);
    console.error("❌ ERREUR CRITIQUE CONFIRMATION:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/public/download-gift-card/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const voucherRes = await pool.query(`SELECT gc.*, ft.name as flight_name FROM gift_cards gc LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id WHERE UPPER(gc.code) = UPPER($1)`, [code]);
    if (voucherRes.rows.length === 0) return res.status(404).send("Bon cadeau introuvable.");

    const voucher = voucherRes.rows[0];
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    
    res.setHeader('Content-Type', 'application/pdf');
    // 🎯 LA CORRECTION EST ICI : Ajout des guillemets (") autour du filename !
    res.setHeader('Content-Disposition', `attachment; filename="Bon_Cadeau_${voucher.code}.pdf"`);
    doc.pipe(res);

    const backgroundSrc = voucher.pdf_background_url || 'cadeau-background.jpg';
    await drawBackground(doc, backgroundSrc);

    // Positionnement et sécurisation des textes avec String()
    const buyerY = 184 * 2.834;
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(14).text(String(voucher.buyer_name || '').toUpperCase(), 0, buyerY, { align: 'center', width: 595 });
    
    const codeX = 90 * 2.834;
    const codeY = 217 * 2.834; 
    doc.fillColor('#f026b8').font('Helvetica-Bold').fontSize(14).text(String(voucher.code), codeX, codeY, { characterSpacing: 2 });

    const textY = 264 * 2.834; 
    if (voucher.custom_line_1) {
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(String(voucher.custom_line_1).toUpperCase(), 30, textY, { width: 535, align: 'center' });
    }
    if (voucher.custom_line_2) {
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(String(voucher.custom_line_2).toUpperCase(), 30, textY + 15, { width: 535, align: 'center' });
    }
    if (voucher.custom_line_3) {
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(String(voucher.custom_line_3).toUpperCase(), 30, textY + 30, { width: 535, align: 'center' });
    }

    const dateV = new Date(voucher.created_at || new Date());
    dateV.setMonth(dateV.getMonth() + 18);
    const validUntil = dateV.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const dateY = codeY + 14 + (13 * 2.834);
    doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(8).text(`VALABLE JUSQU'AU : ${validUntil.toUpperCase()}`, 0, dateY, { align: 'center', width: 595 });

    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8').text('Fluide Parapente - La Clusaz | www.fluideparapente.com', 0, 815, { align: 'center', width: 595 });

    doc.end();
  } catch (err) {
    console.error("Erreur génération PDF:", err);
    if (!res.headersSent) res.status(500).send("Erreur lors de la génération du bon cadeau.");
  }
});


router.get('/api/ical/:id', async (req, res) => {
  try {
    const result = await generateICalFeed(pool, req.params.id);
    if (!result) return res.status(404).send('Moniteur introuvable');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="planning_fluide_${result.monitorName}.ics"`);
    res.send(result.ical);
  } catch (err) {
    console.error('Erreur génération iCal:', err);
    res.status(500).send('Erreur lors de la génération du calendrier');
  }
});


module.exports = router;
