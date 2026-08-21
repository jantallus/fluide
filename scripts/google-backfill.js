// Usage : GOOGLE_SCRIPT_URL=https://... node scripts/google-backfill.js
require('dotenv').config();
const { Pool } = require('pg');

const webhookUrl = process.env.GOOGLE_SCRIPT_URL;
if (!webhookUrl) { console.error('❌ GOOGLE_SCRIPT_URL manquante'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const { rows: slots } = await pool.query(`
    SELECT s.id, s.title, s.start_time, s.end_time, s.phone, s.booking_options, s.client_message,
           u.first_name AS monitor_name
    FROM slots s
    JOIN users u ON u.id = s.monitor_id
    WHERE s.status = 'booked'
      AND s.start_time >= NOW()
      AND s.title IS NOT NULL
      AND s.title NOT LIKE '↪️ Suite%'
      AND s.title NOT LIKE '%NON DISPO%'
      AND s.title NOT LIKE '☕%'
      AND s.title NOT LIKE '%❌%'
    ORDER BY s.start_time ASC
  `);

  console.log(`${slots.length} réservation(s) à envoyer...`);
  let pushed = 0;

  for (const slot of slots) {
    let desc = '';
    if (slot.phone) desc += `Tel: ${slot.phone}\n`;
    if (slot.booking_options) desc += `Options: ${slot.booking_options}\n`;
    if (slot.client_message) desc += `Message client: ${slot.client_message}\n`;

    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monitorName: slot.monitor_name, title: slot.title, startTime: slot.start_time, endTime: slot.end_time, description: desc }),
        redirect: 'follow',
      });
      const text = await resp.text();
      console.log(`✅ ${slot.title} (${slot.start_time}) → ${text.slice(0, 80)}`);
      pushed++;
    } catch (e) {
      console.error(`❌ ${slot.title} : ${e.message}`);
    }

    if (pushed % 10 === 0) await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nTerminé : ${pushed}/${slots.length} envoyées.`);
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
