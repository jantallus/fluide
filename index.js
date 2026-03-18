const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:fuQIzafUNCSMkwiUNeWZKSoMHwfXutDC@yamanote.proxy.rlwy.net:35258/railway",
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || "fluide_secret_key_2026";

const authenticateAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: "Accès refusé" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ message: "Interdit" });
    req.user = decoded;
    next();
  } catch (err) { res.status(401).json({ message: "Token invalide" }); }
};

app.get('/api/admin/appointments', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id::text, monitor_id as "resourceId", title, notes, start_time as start, end_time as end, status FROM slots ORDER BY start_time ASC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/appointments/:id', authenticateAdmin, async (req, res) => {
  const { title, notes, monitor_id, start_time, end_time, status } = req.body;
  try {
    await pool.query(`UPDATE slots SET title = $1, notes = $2, monitor_id = $3, start_time = $4, end_time = $5, status = $6 WHERE id = $7`, [title, notes, monitor_id, start_time, end_time, status, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/appointments/block-all', authenticateAdmin, async (req, res) => {
  const { start_time, notes } = req.body;
  try {
    await pool.query(`UPDATE slots SET status = 'booked', title = '🚫 BLOQUÉ (TOUS)', notes = $1 WHERE start_time = $2`, [notes, start_time]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/appointments/:id/cancel', authenticateAdmin, async (req, res) => {
    try {
        await pool.query("UPDATE slots SET status = 'available', title = NULL, notes = NULL WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/appointments/generate', authenticateAdmin, async (req, res) => {
    const { startDate, endDate, daysToApply } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("DELETE FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 AND status = 'available'", [startDate, endDate]);
        const monitors = await client.query("SELECT id FROM users WHERE role IN ('monitor', 'admin')");
        const defs = await client.query("SELECT * FROM slot_definitions");
        
        let curr = new Date(startDate);
        while (curr <= new Date(endDate)) {
            if (daysToApply.map(Number).includes(curr.getDay())) {
                const y = curr.getFullYear();
                const m = String(curr.getMonth() + 1).padStart(2, '0');
                const d = String(curr.getDate()).padStart(2, '0');
                const dateStr = `${y}-${m}-${d}`;
                
                for (const mon of monitors.rows) {
                    for (const def of defs.rows) {
                        const startTS = `${dateStr} ${def.start_time}`;
                        await client.query("INSERT INTO slots (start_time, end_time, monitor_id, status) VALUES ($1, $1::timestamp + ($2 || ' minutes')::interval, $3, 'available') ON CONFLICT DO NOTHING", [startTS, def.duration_minutes, mon.id]);
                    }
                }
            }
            curr.setDate(curr.getDate() + 1);
        }
        await client.query('COMMIT');
        res.status(201).json({ message: "OK" });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
    finally { client.release(); }
});

app.get('/api/admin/flight-types', authenticateAdmin, async (req, res) => {
    const result = await pool.query("SELECT * FROM flight_types ORDER BY id ASC");
    res.json(result.rows);
});

app.get('/api/monitors', authenticateAdmin, async (req, res) => {
    const r = await pool.query("SELECT id, first_name FROM users WHERE role IN ('monitor', 'admin')");
    res.json(r.rows);
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const r = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (r.rows[0] && await bcrypt.compare(password, r.rows[0].password_hash)) {
        const token = jwt.sign({ id: r.rows[0].id, role: r.rows[0].role }, JWT_SECRET);
        res.json({ token, user: { email, role: r.rows[0].role } });
    } else res.status(401).json({ message: "Erreur" });
});

app.listen(process.env.PORT || 3001);