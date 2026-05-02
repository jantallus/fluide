// services/stripeProcessor.js
// Logique partagée entre la route confirm-booking (redirect) et le webhook Stripe.
// Les deux chemins doivent produire exactement le même résultat pour une session donnée.

const { pool } = require('../db');
const { performBooking } = require('./booking');
const { generatePDFBuffer } = require('./pdf');
const { sendConfirmationEmail, sendConfirmationSMS, sendAdminNotificationEmail } = require('./email');

/**
 * Traite une Checkout Session Stripe déjà payée (payment_status === 'paid').
 * Idempotent : si la session est déjà dans stripe_payments, renvoie le résultat stocké sans rien refaire.
 *
 * @param {object} session — objet Session Stripe (stripe.checkout.sessions.retrieve ou webhook event.data.object)
 * @returns {{ success: true, is_gift_card?: true, code?: string } | null}
 *          null si déjà traité (l'appelant peut logger mais ne doit pas re-notifier)
 */
async function processStripeSession(session) {
  const session_id = session.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Verrou persistant ─────────────────────────────────────────────────────
    // Vérifie si cette session a déjà été traitée (survit aux redémarrages + multi-instances)
    const existing = await client.query(
      'SELECT type, result_code FROM stripe_payments WHERE session_id = $1',
      [session_id]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      console.log(`🛡️ Session déjà traitée (stripe_payments) : ${session_id}`);
      const row = existing.rows[0];
      // On renvoie null pour signaler "déjà traité" — pas de re-notification
      return null;
    }

    // ── CAS 1 : ACHAT BON CADEAU ──────────────────────────────────────────────
    if (session.metadata.purchase_type === 'gift_card') {
      const finalCode = `FLUIDE-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

      const validUntil = new Date();
      const parsedMonths = parseInt(session.metadata.validity_months);
      const monthsToAdd = isNaN(parsedMonths) ? 12 : parsedMonths;
      validUntil.setMonth(validUntil.getMonth() + monthsToAdd);

      let finalNotes = session.metadata.notes || '';
      if (session.metadata.buyer_address) {
        finalNotes = `📮 À POSTER : ${session.metadata.buyer_address}\n` + finalNotes;
      }

      await client.query(
        `INSERT INTO gift_cards
           (code, flight_type_id, buyer_name, buyer_phone, beneficiary_name,
            price_paid_cents, type, status, discount_scope, valid_until,
            notes, pdf_background_url, buyer_address,
            custom_line_1, custom_line_2, custom_line_3)
         VALUES ($1,$2,$3,$4,'',$5,'gift_card','valid','both',$6,$7,$8,$9,$10,$11,$12)`,
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
          session.metadata.custom_line_2 || null,
          session.metadata.custom_line_3 || null,
        ]
      );

      // Enregistrement atomique dans le registre d'idempotence
      await client.query(
        'INSERT INTO stripe_payments (session_id, type, result_code) VALUES ($1, $2, $3)',
        [session_id, 'gift_card', finalCode]
      );

      await client.query('COMMIT');
      console.log(`✅ Bon cadeau créé : ${finalCode} (session ${session_id})`);

      // Notifications asynchrones (hors transaction)
      setImmediate(async () => {
        try {
          const isSpecific = !!session.metadata.flight_type_id;
          const pdfBuf = await generatePDFBuffer({
            code: finalCode,
            buyer_name: session.metadata.buyer_name,
            price_paid_cents: session.metadata.price_paid_cents,
            flight_name: isSpecific ? 'Vol en parapente' : null,
            pdf_background_url: session.metadata.pdf_background_url,
            custom_line_1: session.metadata.custom_line_1,
            custom_line_2: session.metadata.custom_line_2,
            custom_line_3: session.metadata.custom_line_3,
          });
          const flightLabel = isSpecific
            ? 'Vol en parapente'
            : `Avoir de ${(parseInt(session.metadata.price_paid_cents) || 0) / 100}€`;
          await sendConfirmationEmail(
            session.metadata.buyer_email,
            session.metadata.buyer_name,
            'gift_card',
            flightLabel,
            finalCode,
            '',
            null,
            pdfBuf
          );
        } catch (e) {
          console.error('❌ Erreur notifications Bon Cadeau:', e);
        }
      });

      return { success: true, is_gift_card: true, code: finalCode };
    }

    // ── CAS 2 : RÉSERVATION VOL ───────────────────────────────────────────────
    const contact = {
      phone: session.metadata.contact_phone || '',
      email: session.metadata.contact_email || '',
      notes: session.metadata.contact_notes || '',
    };

    // Recompose le JSON passagers depuis les chunks (500 chars / chunk)
    let passengersJson = '';
    let chunkIndex = 0;
    while (session.metadata[`passengers_chunk_${chunkIndex}`] !== undefined) {
      passengersJson += session.metadata[`passengers_chunk_${chunkIndex}`];
      chunkIndex++;
    }
    const passengers = JSON.parse(passengersJson);

    const voucherCode = session.metadata.voucher_code;
    const pData = {
      online: true,
      cb: session.amount_total || 0,
      ...(voucherCode
        ? {
            code: voucherCode,
            code_type: session.metadata.voucher_type || 'promo',
            voucher: parseInt(session.metadata.voucher_discount_cents || '0'),
          }
        : {}),
    };

    await performBooking(client, contact, passengers, pData);

    if (voucherCode) {
      await client.query(
        `UPDATE gift_cards
         SET current_uses = current_uses + 1,
             status = CASE WHEN max_uses IS NOT NULL AND (current_uses + 1) >= max_uses THEN 'used' ELSE status END
         WHERE UPPER(code) = UPPER($1)`,
        [voucherCode]
      );
    }

    // Enregistrement atomique dans le registre d'idempotence
    await client.query(
      'INSERT INTO stripe_payments (session_id, type) VALUES ($1, $2)',
      [session_id, 'flight']
    );

    await client.query('COMMIT');
    console.log(`✅ Vol réservé (session ${session_id})`);

    // Notifications asynchrones (hors transaction)
    setImmediate(async () => {
      try {
        if (passengers.length > 0) {
          const firstPass = passengers[0];
          const beautifulDate = new Date(firstPass.date).toLocaleDateString('fr-FR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          });
          await sendConfirmationEmail(contact.email, session.metadata.contact_name, 'flight', firstPass.flightName, beautifulDate, firstPass.time, firstPass.flightId);
          await sendConfirmationSMS(contact.phone, session.metadata.contact_name, 'flight', beautifulDate, firstPass.time, firstPass.flightId);
          await sendAdminNotificationEmail(session.metadata.contact_name, contact.phone, firstPass.flightName, beautifulDate, firstPass.time);
        }
      } catch (e) {
        console.error('❌ Erreur notifications Vol:', e);
      }
    });

    return { success: true };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err; // Re-throw pour que l'appelant gère (log + réponse HTTP)
  } finally {
    client.release();
  }
}

module.exports = { processStripeSession };
