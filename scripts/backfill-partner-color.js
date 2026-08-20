// scripts/backfill-partner-color.js
// Ajoute partner_color dans payment_data des créneaux réservés via code partenaire
// qui n'ont pas encore cette propriété.
// Usage : node scripts/backfill-partner-color.js

require('dotenv').config();
const { pool } = require('../db');

async function main() {
  const client = await pool.connect();
  try {
    // Créneaux avec un partner_id dans payment_data mais sans partner_color
    const { rows: slots } = await client.query(`
      SELECT id, payment_data
      FROM slots
      WHERE payment_data IS NOT NULL
        AND (payment_data->>'partner')::boolean = true
        AND payment_data->>'partner_id' IS NOT NULL
        AND payment_data->>'partner_color' IS NULL
    `);

    if (slots.length === 0) {
      console.log('Aucun créneau à corriger.');
      return;
    }

    console.log(`${slots.length} créneau(x) à mettre à jour...`);

    // Charge les partenaires une seule fois
    const { rows: partners } = await client.query('SELECT id, name, color_code FROM partners');
    const partnerMap = Object.fromEntries(partners.map(p => [String(p.id), p]));

    let updated = 0;
    let skipped = 0;

    for (const slot of slots) {
      const partnerId = String(slot.payment_data.partner_id);
      const partner = partnerMap[partnerId];

      if (!partner) {
        console.warn(`  Slot ${slot.id} — partenaire id=${partnerId} introuvable, ignoré.`);
        skipped++;
        continue;
      }

      const newPaymentData = { ...slot.payment_data, partner_color: partner.color_code };

      await client.query(
        'UPDATE slots SET payment_data = $1 WHERE id = $2',
        [JSON.stringify(newPaymentData), slot.id]
      );

      console.log(`  Slot ${slot.id} → partenaire "${partner.name}" → couleur ${partner.color_code}`);
      updated++;
    }

    console.log(`\nTerminé : ${updated} mis à jour, ${skipped} ignorés.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
