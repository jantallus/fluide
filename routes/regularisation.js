const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateAdmin } = require('../middleware/auth');

const ONLINE_TYPES = new Set(['cb', 'ancv', 'ancv_connect', 'chq', 'bon_cadeau', 'online']);

function computeCommission(priceEuros, commissionType, commissionValue) {
  if (commissionType === 'percentage') return priceEuros * commissionValue / 100;
  if (commissionType === 'fixed') return commissionValue;
  return 0;
}

router.get('/api/regularisation', authenticateAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'Paramètres from et to requis (YYYY-MM-DD)' });

    const { rows } = await pool.query(
      `SELECT
         s.id,
         s.monitor_id,
         s.start_time,
         s.title,
         s.payment_data,
         s.flight_type_id,
         ft.price_cents,
         ft.name AS flight_name,
         u.first_name,
         u.commission_type,
         u.commission_value
       FROM slots s
       JOIN users u ON u.id::text = s.monitor_id::text
       LEFT JOIN flight_types ft ON ft.id = s.flight_type_id
       WHERE s.status = 'booked'
         AND s.start_time >= $1::date
         AND s.start_time < ($2::date + INTERVAL '1 day')
         AND s.title IS NOT NULL
         AND s.title NOT LIKE '↪️ Suite%'
         AND s.title NOT IN ('NOTE', 'NON DISPO')
         AND s.title NOT LIKE '%PAUSE%'
         AND s.title NOT LIKE '%❌%'
       ORDER BY u.first_name, s.start_time`,
      [from, to]
    );

    // Group by monitor
    const byMonitor = {};
    for (const row of rows) {
      const mid = row.monitor_id;
      if (!byMonitor[mid]) {
        byMonitor[mid] = {
          id: mid,
          first_name: row.first_name,
          commission_type: row.commission_type || 'none',
          commission_value: parseFloat(row.commission_value) || 0,
          flights: [],
        };
      }

      const priceEuros = (row.price_cents || 0) / 100;
      const pd = row.payment_data || {};
      const paymentType = pd.payment_type || null;
      const commission = computeCommission(
        priceEuros,
        byMonitor[mid].commission_type,
        byMonitor[mid].commission_value
      );

      byMonitor[mid].flights.push({
        id: row.id,
        date: row.start_time,
        title: row.title,
        flight_name: row.flight_name || null,
        price_euros: priceEuros,
        payment_type: paymentType,
        encaisseur_id: pd.encaisseur_id || null,
        commission,
      });
    }

    // Compute totals per monitor
    const monitors = Object.values(byMonitor).map(mon => {
      let esp_revenue = 0;
      let online_revenue = 0;
      let np_revenue = 0;
      let unpaid_revenue = 0;
      let commission_on_esp = 0;
      let commission_on_online = 0;

      for (const f of mon.flights) {
        if (f.payment_type === 'esp') {
          esp_revenue += f.price_euros;
          commission_on_esp += f.commission;
        } else if (ONLINE_TYPES.has(f.payment_type)) {
          online_revenue += f.price_euros;
          commission_on_online += f.commission;
        } else if (f.payment_type === 'np') {
          np_revenue += f.price_euros;
        } else {
          // null / not set
          unpaid_revenue += f.price_euros;
        }
      }

      // positive = collective owes monitor; negative = monitor owes collective
      const balance = (online_revenue - commission_on_online) - commission_on_esp;

      return {
        ...mon,
        totals: {
          flights: mon.flights.length,
          total_revenue: esp_revenue + online_revenue,
          esp_revenue,
          online_revenue,
          np_revenue,
          unpaid_revenue,
          commission_on_esp,
          commission_on_online,
          total_commission: commission_on_esp + commission_on_online,
          balance,
        },
      };
    });

    res.json({ monitors, from, to });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
