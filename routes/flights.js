const express = require('express');
const router = express.Router();
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { FlightTypeSchema } = require('../schemas');

router.get('/api/flight-types', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM flight_types ORDER BY price_cents ASC');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/flight-types', authenticateAdmin, validate(FlightTypeSchema), async (req, res) => {
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url, popup_content, show_popup } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'Standard'; 
  
  try {
    const r = await pool.query(
      `INSERT INTO flight_types (name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url, popup_content, show_popup) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [name, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, allow_multi_slots || false, weight_min || 20, weight_max || 110, booking_delay_hours || 0, image_url || null, popup_content || null, show_popup || false]
    );
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.put('/api/flight-types/:id', authenticateAdmin, validate(FlightTypeSchema), async (req, res) => {
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url, popup_content, show_popup } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'Standard';

  try {
    await pool.query(
      `UPDATE flight_types 
       SET name = $1, duration_minutes = $2, price_cents = $3, restricted_start_time = $4, restricted_end_time = $5, color_code = $6, allowed_time_slots = $7, season = $8, allow_multi_slots = $9, weight_min = $10, weight_max = $11, booking_delay_hours = $12, image_url = $13, popup_content = $14, show_popup = $15 
       WHERE id = $16`,
      [name, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, allow_multi_slots || false, weight_min || 20, weight_max || 110, booking_delay_hours || 0, image_url || null, popup_content || null, show_popup || false, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});
 
router.delete('/api/flight-types/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM flight_types WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: "Impossible de supprimer ce vol car il est utilisé." }); 
  }
});

router.get('/api/complements', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM complements WHERE is_active = true ORDER BY price_cents ASC');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/complements', authenticateAdmin, async (req, res) => {
  const { name, description, price_cents, image_url } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO complements (name, description, price_cents, is_active, image_url) VALUES ($1, $2, $3, true, $4) RETURNING *',
      [name, description, price_cents, image_url || null]
    );
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/api/complements/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM complements WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});


module.exports = router;
