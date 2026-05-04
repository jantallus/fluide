const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin } = require('../middleware/auth');

router.get('/api/users', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, first_name, email, role, is_active_monitor, status FROM users ORDER BY first_name ASC');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/users', authenticateAdmin, async (req, res) => {
  const { first_name, email, password, role, is_active_monitor, available_start_date, available_end_date, daily_start_time, daily_end_time } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (first_name, email, password_hash, role, is_active_monitor, status, available_start_date, available_end_date, daily_start_time, daily_end_time) 
       VALUES ($1, $2, $3, $4, $5, 'Actif', $6, $7, $8, $9) RETURNING id, first_name, role`,
      [first_name, email, hash, role, is_active_monitor, available_start_date || null, available_end_date || null, daily_start_time || null, daily_end_time || null]
    );
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.patch('/api/users/:id', authenticateUser, async (req, res) => {
  const { first_name, email, role, is_active_monitor, status, password, available_start_date, available_end_date, daily_start_time, daily_end_time } = req.body;
  try {
    if (req.user.role !== 'admin' && req.user.id !== parseInt(req.params.id)) {
      return res.status(403).json({ error: "Interdit : Vous ne pouvez modifier que votre propre profil." });
    }

    let finalRole = role;
    let finalActive = is_active_monitor;
    let finalStatus = status;
    if (req.user.role !== 'admin') {
      const check = await pool.query('SELECT role, is_active_monitor, status FROM users WHERE id=$1', [req.params.id]);
      finalRole = check.rows[0].role;
      finalActive = check.rows[0].is_active_monitor;
      finalStatus = check.rows[0].status;
    }

    const startD = available_start_date || null;
    const endD = available_end_date || null;
    const startT = daily_start_time || null;
    const endT = daily_end_time || null;

    if (password) {
       const hash = await bcrypt.hash(password, 10);
       await pool.query(
         'UPDATE users SET first_name = $1, email = $2, role = $3, is_active_monitor = $4, status = $5, password_hash = $6, available_start_date = $7, available_end_date = $8, daily_start_time = $9, daily_end_time = $10 WHERE id = $11', 
         [first_name, email, finalRole, finalActive, finalStatus, hash, startD, endD, startT, endT, req.params.id]
       );
    } else {
       await pool.query(
         'UPDATE users SET first_name = $1, email = $2, role = $3, is_active_monitor = $4, status = $5, available_start_date = $6, available_end_date = $7, daily_start_time = $8, daily_end_time = $9 WHERE id = $10', 
         [first_name, email, finalRole, finalActive, finalStatus, startD, endD, startT, endT, req.params.id]
       );
    }
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/api/users/:id', authenticateAdmin, async (req, res) => {
  try {
    if (req.user && req.user.id === req.params.id) return res.status(400).json({ error: "Interdit de supprimer son propre compte." });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/api/users/:id/availabilities', authenticateUser, async (req, res) => {
  try {
    const r = await pool.query('SELECT *, TO_CHAR(start_date, \'YYYY-MM-DD\') as start_date, TO_CHAR(end_date, \'YYYY-MM-DD\') as end_date FROM monitor_availabilities WHERE user_id = $1 ORDER BY start_date ASC', [req.params.id]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.put('/api/users/:id/availabilities', authenticateUser, async (req, res) => {
  const { availabilities } = req.body; 
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM monitor_availabilities WHERE user_id = $1', [req.params.id]);
    for (const a of availabilities) {
      await client.query(
        'INSERT INTO monitor_availabilities (user_id, start_date, end_date, daily_start_time, daily_end_time) VALUES ($1, $2, $3, $4, $5)',
        [req.params.id, a.start_date, a.end_date, a.daily_start_time, a.daily_end_time]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

router.get('/api/monitors-admin', authenticateUser, async (req, res) => {
  try {
    let query = `
      SELECT id, first_name, email, role, is_active_monitor, status, 
             TO_CHAR(available_start_date, 'YYYY-MM-DD') as available_start_date,
             TO_CHAR(available_end_date, 'YYYY-MM-DD') as available_end_date,
             daily_start_time, daily_end_time 
      FROM users 
      WHERE LOWER(role) IN ('admin', 'permanent', 'monitor') 
    `;
    let params = [];

    if (req.user.role === 'monitor') {
      query += ` AND id = $1`;
      params.push(req.user.id);
    }

    query += ` ORDER BY CASE WHEN role = 'admin' THEN 1 WHEN role = 'permanent' THEN 2 ELSE 3 END, first_name ASC`;
    
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/api/monitors', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, first_name FROM users 
      WHERE is_active_monitor = true AND status = 'Actif' AND LOWER(role) IN ('admin', 'permanent', 'monitor')
      ORDER BY first_name ASC
    `);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});


module.exports = router;
