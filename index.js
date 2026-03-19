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

// --- ROUTES PLANNING ---

app.get('/api/admin/appointments', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id::text, monitor_id as "resourceId", title, notes, 
             start_time as start, end_time as end, status
      FROM slots ORDER BY start_time ASC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// MISE À JOUR : On change le CONTENU (titre/notes) mais on ne DELETE jamais la ligne
app.put('/api/admin/appointments/:id', authenticateAdmin, async (req, res) => {
  const { title, notes, status, monitor_id } = req.body;
  try {
    await pool.query(
      `UPDATE slots SET title = $1, notes = $2, status = $3, monitor_id = $4 WHERE id = $5`,
      [title, notes, status, monitor_id, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/appointments/block-all', authenticateAdmin, async (req, res) => {
  const { start_time, notes } = req.body;
  try {
    await pool.query(
      `UPDATE slots SET status = 'booked', title = '🚫 BLOQUÉ (TOUS)', notes = $1 WHERE start_time = $2`,
      [notes, start_time]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/appointments/:id/cancel', authenticateAdmin, async (req, res) => {
    try {
        await pool.query("UPDATE slots SET status = 'available', title = NULL, notes = NULL WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- GÉNÉRATION : ANTI-COLLISION 14:15/14:25 ---
app.post('/api/admin/appointments/generate', authenticateAdmin, async (req, res) => {
    const { startDate, endDate, daysToApply } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // On ne vide que les créneaux Libres pour ne pas écraser les réservations manuelles
        await client.query("DELETE FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 AND status = 'available'", [startDate, endDate]);
        
        const monitors = await client.query("SELECT id FROM users WHERE role IN ('monitor', 'admin')");
        const defs = await client.query("SELECT * FROM slot_definitions");
        
        let curr = new Date(startDate);
        const limit = new Date(endDate);

        while (curr <= limit) {
            if (daysToApply.map(Number).includes(curr.getDay())) {
                const dateStr = curr.getFullYear() + '-' + String(curr.getMonth() + 1).padStart(2, '0') + '-' + String(curr.getDate()).padStart(2, '0');

                for (const m of monitors.rows) {
                    for (const d of defs.rows) {
                        const startTS = `${dateStr} ${d.start_time}`;
                        const isPause = d.label === "PAUSE";
                        
                        // ON CONFLICT DO NOTHING : Crucial pour éviter le conflit si une pause finit à l'heure exacte où un vol commence
                        await client.query(`
                            INSERT INTO slots (start_time, end_time, monitor_id, status, title) 
                            VALUES ($1, $1::timestamp + ($2 || ' minutes')::interval, $3, $4, $5) 
                            ON CONFLICT (start_time, monitor_id) DO NOTHING`,
                            [startTS, d.duration_minutes, m.id, isPause ? 'booked' : 'available', isPause ? '☕ PAUSE' : null]
                        );
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

app.get('/api/admin/config/slots-definitions', authenticateAdmin, async (req, res) => {
    const r = await pool.query("SELECT * FROM slot_definitions ORDER BY start_time ASC");
    res.json(r.rows);
});

app.post('/api/admin/config/slots-definitions', authenticateAdmin, async (req, res) => {
    const { start_time, duration_minutes, label } = req.body;
    await pool.query("INSERT INTO slot_definitions (start_time, duration_minutes, label) VALUES ($1,$2,$3)", [start_time, duration_minutes, label]);
    res.json({ success: true });
});

app.delete('/api/admin/config/slots-definitions/:id', authenticateAdmin, async (req, res) => {
    await pool.query("DELETE FROM slot_definitions WHERE id = $1", [req.params.id]);
    res.json({ success: true });
});

app.get('/api/admin/flight-types', authenticateAdmin, async (req, res) => {
    const r = await pool.query("SELECT * FROM flight_types ORDER BY id ASC");
    res.json(r.rows);
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