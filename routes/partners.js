const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateAdmin } = require('../middleware/auth');

router.get('/api/partners', authenticateAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM partners ORDER BY name ASC');
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/partners', authenticateAdmin, async (req, res) => {
  const { name, code, color_code, booking_fields, commission_type, commission_value } = req.body;
  if (!name?.trim() || !code?.trim()) return res.status(400).json({ error: 'Nom et code requis' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO partners (name, code, color_code, booking_fields, commission_type, commission_value)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name.trim(), code.trim().toUpperCase(), color_code || '#6366f1', JSON.stringify(booking_fields || {}),
       commission_type || 'none', commission_value ?? 0]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ce code existe déjà.' });
    console.error(err); res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/api/partners/:id', authenticateAdmin, async (req, res) => {
  const { name, code, color_code, booking_fields, is_active, commission_type, commission_value } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE partners SET name=$1, code=$2, color_code=$3, booking_fields=$4, is_active=$5,
                           commission_type=$6, commission_value=$7
       WHERE id=$8 RETURNING *`,
      [name.trim(), code.trim().toUpperCase(), color_code || '#6366f1', JSON.stringify(booking_fields || {}),
       is_active ?? true, commission_type || 'none', commission_value ?? 0, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Partenaire introuvable' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ce code existe déjà.' });
    console.error(err); res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/api/partners/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM partners WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;
