const express = require('express');
const router = express.Router();
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin } = require('../middleware/auth');
const Stripe = require('stripe');
const { sendConfirmationEmail, sendConfirmationSMS, sendAdminNotificationEmail, notifyGoogleCalendar } = require('../services/email');
const { generatePDFBuffer, drawBackground } = require('../services/pdf');
const PDFDocument = require('pdfkit');
const { googleSyncCache } = require('../services/googleSync');

router.get('/api/public/availabilities', async (req, res) => {
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
      slots = slots.map(slot => {
        if (slot.status === 'available' && slot.monitor_id) {
          const googleBusySlots = googleSyncCache.get(slot.monitor_id) || [];
          const slotStart = new Date(slot.start_time).getTime();
          const isBusy = googleBusySlots.some(g => slotStart >= g.start && slotStart < g.end);
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
router.post('/api/public/checkout-gift-card', async (req, res) => {
  // 🎯 NOUVEAU : On récupère selectedComplements (les options)
  const { template, buyer, physicalShipping, selectedComplements } = req.body; 
  try {
    const shipRes = await pool.query("SELECT value FROM site_settings WHERE key = 'physical_gift_card_price'");
    const shipPriceCents = shipRes.rows.length > 0 ? (parseInt(shipRes.rows[0].value) || 0) * 100 : 0;

    const line_items = [{
      price_data: {
        currency: 'eur',
        product_data: { name: template.title, description: `Bon cadeau offert par : ${buyer.name}` },
        unit_amount: template.price_cents
      },
      quantity: 1
    }];

    // 🎯 NOUVEAU : On ajoute les options (photos/vidéos) à la facture Stripe
    let optionsTotalCents = 0;
    let optionsText = "";
    if (selectedComplements && selectedComplements.length > 0) {
      const names = [];
      for (const comp of selectedComplements) {
        optionsTotalCents += comp.price_cents;
        names.push(comp.name);
        line_items.push({
          price_data: {
            currency: 'eur',
            product_data: { name: `Option incluse : ${comp.name}` },
            unit_amount: comp.price_cents
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
        price_paid_cents: String((template.price_cents || 0) + optionsTotalCents).substring(0, 499),
        validity_months: String(template.validity_months || 12).substring(0, 499),
        flight_type_id: String(template.flight_type_id || '').substring(0, 499),
        image_url: String(template.image_url || '').substring(0, 499),
        pdf_background_url: String(template.pdf_background_url || '').substring(0, 499),
        buyer_address: physicalShipping && physicalShipping.enabled ? String(physicalShipping.address).substring(0, 499) : '',
        notes: String(optionsText).substring(0, 499),
        // 🎯 NOUVEAU : On glisse les lignes de texte dans le sac à dos de Stripe
        custom_line_1: String(template.custom_line_1 || '').substring(0, 80),
        custom_line_2: String(template.custom_line_2 || '').substring(0, 80),
        custom_line_3: String(template.custom_line_3 || '').substring(0, 80) // 👈 NOUVEAU
      }
    };
    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur Checkout Stripe Cadeau:", err);
    res.status(500).json({ error: err.message });
  }
});

async function performBooking(client, contact, passengers, paymentStatus = null) {
  for (const p of passengers) {
    const flightRes = await client.query('SELECT * FROM flight_types WHERE id = $1', [p.flightId]);
    const flight = flightRes.rows[0];
    const flightDur = flight.duration_minutes || 15;

    const slotsRes = await client.query(`SELECT * FROM slots WHERE start_time::date = $1 AND status = 'available' ORDER BY start_time ASC`, [p.date]);
    const availableSlots = slotsRes.rows;
    let baseDur = 15;
    if (availableSlots.length > 0) {
      const s1 = new Date(availableSlots[0].start_time).getTime();
      const e1 = new Date(availableSlots[0].end_time).getTime();
      baseDur = Math.round((e1 - s1) / 60000) || 15;
    }
    const slotsNeeded = Math.ceil(flightDur / baseDur);

    const monSchedules = {};
    availableSlots.forEach(s => {
      if (!monSchedules[s.monitor_id]) monSchedules[s.monitor_id] = [];
      monSchedules[s.monitor_id].push(s);
    });

    let chosenMonitor = null;
    let slotsToBook = [];

    for (const monId of Object.keys(monSchedules)) {
      const monSlots = monSchedules[monId].sort((a,b) => new Date(a.start_time) - new Date(b.start_time));
      let startIndex = -1;
      for (let i = 0; i < monSlots.length; i++) {
         const d = new Date(monSlots[i].start_time);
         const tStr = d.toLocaleTimeString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
         if (tStr === p.time) { startIndex = i; break; }
      }

      if (startIndex !== -1 && startIndex + slotsNeeded <= monSlots.length) {
          let isValid = true;
          let sequence = [monSlots[startIndex]];
          for (let i = 1; i < slotsNeeded; i++) {
              const prevEnd = new Date(monSlots[startIndex + i - 1].end_time).getTime();
              const currStart = new Date(monSlots[startIndex + i].start_time).getTime();
              if (Math.abs(currStart - prevEnd) > 60000) { isValid = false; break; }
              sequence.push(monSlots[startIndex + i]);
          }
          if (isValid) {
              chosenMonitor = monId;
              slotsToBook = sequence;
              break; 
          }
      }
    }

    if (!chosenMonitor) throw new Error(`Plus de moniteur dispo pour ${p.firstName} à ${p.time}`);

    let optionsNames = [];
    if (p.selectedComplements && p.selectedComplements.length > 0) {
      for (const compId of p.selectedComplements) {
        const compRes = await client.query('SELECT name FROM complements WHERE id = $1', [compId]);
        if (compRes.rows[0]) optionsNames.push(compRes.rows[0].name);
      }
    }
    const bookingOptions = optionsNames.length > 0 ? optionsNames.join(', ') : null;
    const clientMessage = contact.notes ? contact.notes : null;

    let isFirstSlot = true;
    for (const slot of slotsToBook) {
      const lastName = contact.lastName ? contact.lastName.toUpperCase() : "";
      const fullName = `${p.firstName} ${lastName}`.trim();
      const slotTitle = isFirstSlot ? fullName : `↪️ Suite ${fullName}`;
      const slotNotes = isFirstSlot ? null : 'Extension auto';

      await client.query(`
        UPDATE slots 
        SET status = 'booked', title = $1, notes = $8, phone = $3, email = $4, weight_checked = true, flight_type_id = $5, booking_options = $6, client_message = $7, payment_status = $9
        WHERE id = $2
      `, [slotTitle, slot.id, contact.phone, contact.email, p.flightId, bookingOptions, clientMessage, slotNotes, paymentStatus]);
      
// 🎯 NOUVEAU : ON PRÉVIENT GOOGLE INSTANTANÉMENT (SI ACTIVÉ)
      try {
        const syncSetting = await client.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
        if (syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true') {
          const monRes = await client.query('SELECT first_name FROM users WHERE id = $1', [chosenMonitor]);
          if (monRes.rows.length > 0) {
            const monitorName = monRes.rows[0].first_name;
            let desc = "";
            if (contact.phone) desc += `Tel: ${contact.phone}\n`;
            if (bookingOptions) desc += `Options: ${bookingOptions}\n`;
            if (clientMessage) desc += `Message client: ${clientMessage}\n`;

            if (isFirstSlot) {
              await notifyGoogleCalendar(monitorName, slotTitle, slot.start_time, slot.end_time, desc);
            }
          }
        }
      } catch(e) { console.error("Erreur Synchro Google:", e); }

      const index = availableSlots.findIndex(s => s.id === slot.id);
      if(index > -1) availableSlots.splice(index, 1);
      isFirstSlot = false;
    }
  } 
}

router.post('/api/public/checkout', async (req, res) => {
  const { contact, passengers, voucher_code } = req.body;
  const client = await pool.connect();

  try {
    let flightTotalCents = 0;
    let complementsTotalCents = 0;
    const line_items = [];

    for (const p of passengers) {
      const flightRes = await client.query('SELECT name, price_cents FROM flight_types WHERE id = $1', [p.flightId]);
      const flight = flightRes.rows[0];
      if (flight) {
        flightTotalCents += flight.price_cents;
        line_items.push({
          price_data: { currency: 'eur', product_data: { name: `Vol ${flight.name}`, description: `Passager: ${p.firstName} - Le ${p.date} à ${p.time}` }, unit_amount: flight.price_cents }, quantity: 1
        });
      }
      if (p.selectedComplements && p.selectedComplements.length > 0) {
        for (const compId of p.selectedComplements) {
          const compRes = await client.query('SELECT name, price_cents FROM complements WHERE id = $1', [compId]);
          const comp = compRes.rows[0];
          if (comp) {
            complementsTotalCents += comp.price_cents;
            line_items.push({
              price_data: { currency: 'eur', product_data: { name: `Option: ${comp.name} (pour ${p.firstName})` }, unit_amount: comp.price_cents }, quantity: 1
            });
          }
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
      let pStatus = 'À régler sur place';
      if (appliedVoucher) {
        pStatus = appliedVoucher.type === 'gift_card' ? `Payé (Bon Cadeau : ${appliedVoucher.code})` : `Payé (Promo : ${appliedVoucher.code})`;
      }
      await performBooking(client, contact, passengers, pStatus);
      
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
      voucher_code: appliedVoucher ? appliedVoucher.code : ''
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

// 🎯 SECURISE : CONFIRMATION DES PAIEMENTS
// 🛡️ NOUVEAU : Mémoire anti-doublon (Empêche React de valider 2 fois le même achat)
const activeCheckoutSessions = new Set();

// 🎯 SECURISE : CONFIRMATION DES PAIEMENTS
router.post('/api/public/confirm-booking', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: "Session ID manquant" });

  if (session_id.startsWith('GRATUIT_')) return res.json({ success: true });

  // 🛡️ SÉCURITÉ ANTI-DOUBLON : Si le serveur est déjà en train de traiter cet achat, on bloque !
  if (activeCheckoutSessions.has(session_id)) {
    console.log("🛡️ Doublon bloqué par sécurité pour la session :", session_id);
    return res.json({ success: true, message: "Achat déjà validé" });
  }
  activeCheckoutSessions.add(session_id); // 🔒 On verrouille la session

  // On programme le nettoyage du verrou après 1 heure pour ne pas saturer la mémoire
  setTimeout(() => activeCheckoutSessions.delete(session_id), 3600000);

  const client = await pool.connect(); 
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.status(400).json({ error: "Le paiement n'a pas abouti." });

    await client.query('BEGIN'); 

    // --- CAS 1 : ACHAT BON CADEAU ---
    if (session.metadata.purchase_type === 'gift_card') {
      const finalCode = `FLUIDE-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      
      // 🛡️ SÉCURITÉ ABSOLUE SUR LA DATE
      const validUntil = new Date();
      const parsedMonths = parseInt(session.metadata.validity_months);
      const monthsToAdd = isNaN(parsedMonths) ? 12 : parsedMonths;
      validUntil.setMonth(validUntil.getMonth() + monthsToAdd);

      // 🛡️ SÉCURITÉ ABSOLUE SUR LA BASE DE DONNÉES
      let finalNotes = session.metadata.notes || '';
      if (session.metadata.buyer_address) {
         finalNotes = `📮 À POSTER : ${session.metadata.buyer_address}\n` + finalNotes;
      }

      await client.query(
        `INSERT INTO gift_cards (code, flight_type_id, buyer_name, buyer_phone, beneficiary_name, price_paid_cents, type, status, discount_scope, valid_until, notes, pdf_background_url, buyer_address, custom_line_1, custom_line_2, custom_line_3) 
         VALUES ($1, $2, $3, $4, '', $5, 'gift_card', 'valid', 'both', $6, $7, $8, $9, $10, $11, $12)`,
        [
          finalCode, 
          session.metadata.flight_type_id ? parseInt(session.metadata.flight_type_id) : null, 
          session.metadata.buyer_name || 'Client Inconnu', 
          session.metadata.buyer_phone || null, 
          parseInt(session.metadata.price_paid_cents) || 0, 
          validUntil, 
          finalNotes, 
          session.metadata.pdf_background_url || null,
          session.metadata.buyer_address || null,
          session.metadata.custom_line_1 || null, 
          session.metadata.custom_line_2 || null, // 👈 CORRECTION : La fameuse virgule manquante !
          session.metadata.custom_line_3 || null  
        ]
      );

      await client.query('COMMIT');

      setImmediate(async () => {
        try {
          const isSpecific = !!session.metadata.flight_type_id;
          const pdfBuf = await generatePDFBuffer({ 
              code: finalCode, 
              buyer_name: session.metadata.buyer_name, 
              price_paid_cents: session.metadata.price_paid_cents, 
              flight_name: isSpecific ? "Vol en parapente" : null, 
              pdf_background_url: session.metadata.pdf_background_url,
              custom_line_1: session.metadata.custom_line_1, 
              custom_line_2: session.metadata.custom_line_2, // 👈 CORRECTION : Virgule ajoutée !
              custom_line_3: session.metadata.custom_line_3  
          });
          await sendConfirmationEmail(session.metadata.buyer_email, session.metadata.buyer_name, 'gift_card', isSpecific ? "Vol en parapente" : `Avoir de ${(parseInt(session.metadata.price_paid_cents)||0)/100}€`, finalCode, "", null, pdfBuf);
        } catch (e) { console.error("❌ Erreur notifications Bon Cadeau:", e); }
      });

      return res.json({ success: true, is_gift_card: true, code: finalCode });
    }

    // --- CAS 2 : RÉSERVATION VOL ---
    const contact = { phone: session.metadata.contact_phone || '', email: session.metadata.contact_email || '', notes: session.metadata.contact_notes || '' };
    let passengersJson = '';
    let chunkIndex = 0;
    while (session.metadata[`passengers_chunk_${chunkIndex}`] !== undefined) {
      passengersJson += session.metadata[`passengers_chunk_${chunkIndex}`];
      chunkIndex++;
    }
    const passengers = JSON.parse(passengersJson);
    
    let pStatus = session.metadata.voucher_code ? `Payé (CB + Code : ${session.metadata.voucher_code})` : 'Payé (CB en ligne)';
    
    await performBooking(client, contact, passengers, pStatus);

    if (session.metadata.voucher_code) {
        await client.query(`UPDATE gift_cards SET current_uses = current_uses + 1, status = CASE WHEN max_uses IS NOT NULL AND (current_uses + 1) >= max_uses THEN 'used' ELSE status END WHERE UPPER(code) = UPPER($1)`, [session.metadata.voucher_code]);
    }

    await client.query('COMMIT'); 
    res.json({ success: true });

    setImmediate(async () => {
      try {
        if (passengers.length > 0) {
          const firstPass = passengers[0];
          const beautifulDate = new Date(firstPass.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
          await sendConfirmationEmail(contact.email, session.metadata.contact_name, 'flight', firstPass.flightName, beautifulDate, firstPass.time, firstPass.flightId);
          await sendConfirmationSMS(contact.phone, session.metadata.contact_name, 'flight', beautifulDate, firstPass.time, firstPass.flightId);
          await sendAdminNotificationEmail(session.metadata.contact_name, contact.phone, firstPass.flightName, beautifulDate, firstPass.time);
        }
      } catch (e) { console.error("❌ Erreur notifications Vol:", e); }
    });

  } catch (err) {
    await client.query('ROLLBACK'); 
    activeCheckoutSessions.delete(session_id); // 🔓 On déverrouille si ça a planté
    console.error("❌ ERREUR CRITIQUE CONFIRMATION:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
    const monitorId = req.params.id;
    
    const userRes = await pool.query('SELECT first_name FROM users WHERE id = $1', [monitorId]);
    if (userRes.rows.length === 0) return res.status(404).send("Moniteur introuvable");
    const monitorName = userRes.rows[0].first_name;

    // FILTRE 1 : SQL (On enlève le maximum ici)
    const slotsRes = await pool.query(`
      SELECT s.*, ft.name as flight_name 
      FROM slots s 
      LEFT JOIN flight_types ft ON s.flight_type_id = ft.id 
      WHERE s.monitor_id = $1 
        AND s.status = 'booked' 
        AND s.title IS NOT NULL
        AND s.title NOT LIKE '↪️ Suite%' 
        AND s.title != 'NOTE'
        AND s.start_time >= NOW() - INTERVAL '30 days'
      ORDER BY s.start_time ASC
    `, [monitorId]);

    let ical = "BEGIN:VCALENDAR\r\n";
    ical += "VERSION:2.0\r\n";
    ical += `PRODID:-//Fluide Parapente//${monitorName}//FR\r\n`;
    ical += "CALSCALE:GREGORIAN\r\n";
    ical += `X-WR-CALNAME:Planning Fluide - ${monitorName}\r\n`; 
    ical += "X-WR-TIMEZONE:Europe/Paris\r\n";

    const formatDate = (date) => {
      return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    slotsRes.rows.forEach(slot => {
      const title = slot.title || "";
      const upperTitle = title.toUpperCase();
      
      // FILTRE 2 : JAVASCRIPT (Barrage absolu anti-pauses et blocages)
      if (
        upperTitle.includes('PAUSE') || 
        upperTitle.includes('NON DISPO') || 
        title.includes('☕') || 
        title.includes('❌') ||
        upperTitle === 'NOTE'
      ) {
        return; // On l'éjecte du calendrier !
      }

      const start = new Date(slot.start_time);
      const end = new Date(slot.end_time);
      const flightName = slot.flight_name || "";
      
      let summary = title;
      if (flightName) summary += ` (${flightName})`;

      let description = "";
      if (slot.phone) description += `Tel: ${slot.phone}\\n`;
      if (slot.booking_options) description += `Options: ${slot.booking_options}\\n`;
      if (slot.notes) description += `Notes: ${slot.notes}\\n`;
      if (slot.client_message) description += `Message client: ${slot.client_message}\\n`;

      ical += "BEGIN:VEVENT\r\n";
      ical += `UID:slot-${slot.id}@fluide-parapente.fr\r\n`;
      ical += `DTSTAMP:${formatDate(new Date())}\r\n`;
      ical += `DTSTART:${formatDate(start)}\r\n`;
      ical += `DTEND:${formatDate(end)}\r\n`;
      ical += `SUMMARY:${summary}\r\n`;
      if (description) ical += `DESCRIPTION:${description}\r\n`;
      ical += "END:VEVENT\r\n";
    });

    ical += "END:VCALENDAR\r\n";

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="planning_fluide_${monitorName}.ics"`);
    res.send(ical);

  } catch (err) {
    console.error("Erreur génération iCal:", err);
    res.status(500).send("Erreur lors de la génération du calendrier");
  }
});


module.exports = router;
