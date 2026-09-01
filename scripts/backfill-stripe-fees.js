// scripts/backfill-stripe-fees.js
// Récupère les frais Stripe (fee + net) pour tous les paiements en ligne
// qui n'ont pas encore stripe_fee_cents dans payment_data.
//
// Stratégie de matching :
//   1. Itère sur stripe_payments (type='flight')
//   2. Récupère la session Stripe → payment_intent → balance_transaction
//   3. Cherche les slots correspondants via phone/email du metadata + montant cb
//
// Usage : node scripts/backfill-stripe-fees.js [--dry-run]

require('dotenv').config();
const Stripe = require('stripe');
const { pool } = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY manquant.');
    process.exit(1);
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const client = await pool.connect();

  try {
    // 1. Tous les slots online sans stripe_fee_cents
    const { rows: onlineSlots } = await client.query(`
      SELECT id, phone, email, payment_data
      FROM slots
      WHERE payment_data IS NOT NULL
        AND (payment_data->>'online')::boolean = true
        AND payment_data->>'stripe_fee_cents' IS NULL
        AND status = 'booked'
        AND title NOT LIKE '↪️ Suite%'
    `);

    if (onlineSlots.length === 0) {
      console.log('✅ Aucun slot à mettre à jour (déjà complets ou aucun paiement en ligne).');
      return;
    }
    console.log(`${onlineSlots.length} slot(s) en ligne sans frais Stripe.\n`);

    // Index par phone/email+cb pour matching rapide
    const slotIndex = {};
    for (const slot of onlineSlots) {
      const cb = slot.payment_data?.cb;
      const keys = [];
      if (slot.phone && cb) keys.push(`phone:${slot.phone.replace(/\s/g, '')}:${cb}`);
      if (slot.email && cb) keys.push(`email:${slot.email.toLowerCase()}:${cb}`);
      for (const key of keys) {
        if (!slotIndex[key]) slotIndex[key] = [];
        slotIndex[key].push(slot);
      }
    }

    // 2. Toutes les sessions Stripe enregistrées (type=flight)
    const { rows: stripePayments } = await client.query(
      `SELECT session_id, processed_at FROM stripe_payments WHERE type = 'flight' ORDER BY processed_at ASC`
    );
    console.log(`${stripePayments.length} session(s) Stripe à traiter.\n`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const sp of stripePayments) {
      try {
        // 3. Récupérer la session Stripe
        const session = await stripe.checkout.sessions.retrieve(sp.session_id, {
          expand: ['payment_intent.latest_charge.balance_transaction'],
        });

        if (session.payment_status !== 'paid') { skipped++; continue; }

        const pi = session.payment_intent;
        const bt = pi?.latest_charge?.balance_transaction;

        if (!bt || typeof bt !== 'object') {
          console.warn(`  Session ${sp.session_id} — balance_transaction indisponible, ignorée.`);
          skipped++;
          continue;
        }

        const feeCents = bt.fee;
        const netCents = bt.net;
        const amount = session.amount_total;
        const phone = (session.metadata?.contact_phone || '').replace(/\s/g, '');
        const email = (session.metadata?.contact_email || '').toLowerCase();

        // 4. Trouver les slots correspondants
        const candidates = new Map();
        const phoneKey = phone ? `phone:${phone}:${amount}` : null;
        const emailKey = email ? `email:${email}:${amount}` : null;
        for (const key of [phoneKey, emailKey]) {
          if (!key) continue;
          for (const slot of (slotIndex[key] || [])) {
            candidates.set(slot.id, slot);
          }
        }

        if (candidates.size === 0) {
          console.warn(`  Session ${sp.session_id} — aucun slot trouvé (phone=${phone}, email=${email}, cb=${amount}).`);
          skipped++;
          continue;
        }

        for (const slot of candidates.values()) {
          const newPd = { ...slot.payment_data, stripe_fee_cents: feeCents, stripe_net_cents: netCents, stripe_session_id: sp.session_id };
          if (!DRY_RUN) {
            await client.query('UPDATE slots SET payment_data = $1 WHERE id = $2', [JSON.stringify(newPd), slot.id]);
          }
          // Retirer du index pour éviter double traitement
          for (const key of Object.keys(slotIndex)) {
            slotIndex[key] = slotIndex[key].filter(s => s.id !== slot.id);
          }
          console.log(`  ${DRY_RUN ? '[DRY] ' : ''}Slot ${slot.id} — fee=${feeCents}¢, net=${netCents}¢ (session ${sp.session_id})`);
          updated++;
        }
      } catch (e) {
        console.error(`  Session ${sp.session_id} — erreur : ${e.message}`);
        errors++;
      }
    }

    console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Terminé : ${updated} mis à jour, ${skipped} ignorés, ${errors} erreurs.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
