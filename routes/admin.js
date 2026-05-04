const express = require('express');
const router = express.Router();
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin } = require('../middleware/auth');

router.get('/api/clients', authenticateAdmin, async (req, res) => {
  const q      = (req.query.q || '').trim();
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
  const offset = (page - 1) * limit;
  const search = q ? `%${q}%` : '%';

  const BASE_WHERE = `
    s.status = 'booked'
    AND s.title IS NOT NULL
    AND s.title != 'NOTE'
    AND s.title NOT LIKE '☕%'
    AND s.title NOT LIKE '%NON DISPO%'
    AND s.title NOT LIKE '↪️ Suite%'
    AND s.title NOT LIKE '%❌%'
    AND LOWER(s.title) LIKE LOWER($1)
  `;

  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT s.title) AS total FROM slots s WHERE ${BASE_WHERE}`, [search]),
      pool.query(`
        SELECT
          MAX(s.id)   AS id,
          s.title     AS first_name,
          ''          AS last_name,
          MAX(s.email) AS email,
          MAX(s.phone) AS phone,
          MAX(CASE WHEN s.start_time >= NOW() THEN 1 ELSE 0 END) AS has_upcoming,
          json_agg(
            json_build_object(
              'id',           s.id,
              'start_time',   s.start_time,
              'payment_data', s.payment_data,
              'monitor_name', COALESCE(u.first_name, 'Non assigné'),
              'monitor_id',   s.monitor_id,
              'flight_name',  COALESCE(ft.name, 'Vol personnalisé'),
              'price_cents',  COALESCE(ft.price_cents, 0)
            ) ORDER BY
              CASE WHEN s.start_time >= NOW() THEN 0 ELSE 1 END ASC,
              CASE WHEN s.start_time >= NOW() THEN s.start_time END ASC,
              CASE WHEN s.start_time <  NOW() THEN s.start_time END DESC
          ) AS flights
        FROM slots s
        LEFT JOIN users       u  ON s.monitor_id    = u.id
        LEFT JOIN flight_types ft ON s.flight_type_id = ft.id
        WHERE ${BASE_WHERE}
        GROUP BY s.title
        ORDER BY has_upcoming DESC, MAX(s.start_time) DESC
        LIMIT $2 OFFSET $3
      `, [search, limit, offset]),
    ]);

    const total = parseInt(countRes.rows[0].total);
    res.json({ clients: dataRes.rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


router.get('/api/dashboard-stats', authenticateAdmin, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
    const summary = await pool.query(`SELECT COUNT(*) as total_slots, COUNT(*) FILTER (WHERE status = 'booked' AND (title NOT LIKE '☕%' OR title IS NULL)) as booked_slots, COALESCE(SUM(ft.price_cents), 0) as revenue FROM slots s LEFT JOIN flight_types ft ON s.flight_type_id = ft.id WHERE s.start_time::date = $1`, [today]);
    const upcoming = await pool.query(`SELECT s.id, s.start_time, s.title, ft.name as flight_name, u.first_name as monitor_name, s.notes FROM slots s LEFT JOIN flight_types ft ON s.flight_type_id = ft.id LEFT JOIN users u ON s.monitor_id = u.id WHERE s.start_time::date = $1 AND s.status = 'booked' AND (s.title NOT LIKE '☕%' OR s.title IS NULL) AND s.start_time >= (NOW() AT TIME ZONE 'Europe/Paris') ORDER BY s.start_time ASC LIMIT 5`, [today]);
    res.json({ summary: { todaySlots: parseInt(summary.rows[0].total_slots) || 0, bookedSlots: parseInt(summary.rows[0].booked_slots) || 0, revenue: parseInt(summary.rows[0].revenue) || 0 }, upcoming: upcoming.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/api/settings', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM site_settings');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/settings', authenticateAdmin, async (req, res) => {
  const { key, value } = req.body;
  try {
    await pool.query(`INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/api/stats', authenticateAdmin, async (req, res) => {
  try {
    const summaryResult = await pool.query(`SELECT COALESCE(SUM(ft.price_cents), 0) as total_revenue, COUNT(s.id) as total_bookings FROM slots s JOIN flight_types ft ON s.flight_type_id = ft.id WHERE s.status = 'booked' AND (s.title NOT LIKE '☕%' OR s.title IS NULL)`);
    const upcomingResult = await pool.query(`SELECT s.id, s.start_time, s.title as client_name, ft.name as flight_name, ft.price_cents as total_price, u.first_name as monitor_name FROM slots s JOIN flight_types ft ON s.flight_type_id = ft.id LEFT JOIN users u ON s.monitor_id = u.id WHERE s.status = 'booked' AND s.start_time >= NOW() ORDER BY s.start_time ASC`);
    res.json({ summary: { totalRevenue: parseInt(summaryResult.rows[0].total_revenue), totalBookings: parseInt(summaryResult.rows[0].total_bookings) }, upcoming: upcomingResult.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ⚡ ROUTE PUBLIQUE VITESSE LUMIÈRE (100% SQL + Mémoire RAM)

router.post('/api/clients/bulk-delete', authenticateUser, async (req, res) => {
  const { ids } = req.body;
  if (!ids || ids.length === 0) return res.status(400).json({ error: "Aucun ID" });
  
  try {
    // On récupère tous les codes cadeaux des créneaux sélectionnés
    const slotsRes = await pool.query('SELECT payment_data FROM slots WHERE id = ANY($1::int[])', [ids]);
    const codesToDelete = [];

    for (const row of slotsRes.rows) {
      if (row.payment_data?.code && row.payment_data?.code_type === 'gift_card') {
        codesToDelete.push(row.payment_data.code.toUpperCase());
      }
    }

    if (codesToDelete.length > 0) {
      await pool.query(`DELETE FROM gift_cards WHERE UPPER(code) = ANY($1::text[]) AND type = 'gift_card'`, [codesToDelete]);
    }

    await pool.query(`UPDATE slots SET status = 'available', payment_data = NULL, title = NULL, phone = NULL, email = NULL, notes = NULL, booking_options = NULL, client_message = NULL, flight_type_id = NULL, weight = NULL WHERE id = ANY($1::int[])`, [ids]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 📅 GÉNÉRATEUR DE FLUX ICAL (CALENDRIER PILOTES)
// ==========================================

module.exports = router;
