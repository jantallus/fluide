const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateAdminOrPartnerOrPartner } = require('../middleware/auth');

router.get('/api/standby', authenticateAdminOrPartner, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM standby_clients ORDER BY
        CASE status WHEN 'done' THEN 2 WHEN 'scheduled' THEN 1 ELSE 0 END,
        CASE WHEN availability_start IS NOT NULL THEN availability_start ELSE created_at::date END ASC,
        created_at ASC`
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/standby', authenticateAdminOrPartner, async (req, res) => {
  const { name, phone, email, nb_passengers, flight_type, weight_info, availability_text, availability_start, availability_end, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO standby_clients (name, phone, email, nb_passengers, flight_type, weight_info, availability_text, availability_start, availability_end, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING *`,
      [name||null, phone||null, email||null, nb_passengers||1, flight_type||null, weight_info||null, availability_text||null,
       availability_start||null, availability_end||null, notes||null]
    );
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.put('/api/standby/:id', authenticateAdminOrPartner, async (req, res) => {
  const { name, phone, email, nb_passengers, flight_type, weight_info, availability_text, availability_start, availability_end, notes, pilot_name, booked_date, booked_time, slot_id, status } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE standby_clients SET
        name=$1, phone=$2, email=$3, nb_passengers=$4, flight_type=$5, weight_info=$6,
        availability_text=$7, availability_start=$8, availability_end=$9, notes=$10,
        pilot_name=$11, booked_date=$12, booked_time=$13, slot_id=$14, status=$15,
        updated_at=NOW()
       WHERE id=$16 RETURNING *`,
      [name||null, phone||null, email||null, nb_passengers||1, flight_type||null, weight_info||null,
       availability_text||null, availability_start||null, availability_end||null, notes||null,
       pilot_name||null, booked_date||null, booked_time||null, slot_id||null, status||'pending',
       req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Introuvable' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/api/standby/:id', authenticateAdminOrPartner, async (req, res) => {
  try {
    await pool.query('DELETE FROM standby_clients WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;
