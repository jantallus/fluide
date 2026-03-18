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

// --- ROUTES RÉSERVATION ET LECTURE ---

app.get('/api/admin/appointments', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id::text as id, 
        monitor_id::text as "resourceId", 
        title, 
        notes, 
        start_time as start, 
        end_time as end, 
        status
      FROM slots 
      ORDER BY start_time ASC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/appointments/:id/book', authenticateAdmin, async (req, res) => {
    const { name, phone } = req.body;
    try {
        await pool.query(
            "UPDATE slots SET status = 'booked', title = $1, notes = $2 WHERE id = $3",
            [name, phone, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- GÉNÉRATION ---

app.post('/api/admin/appointments/generate', authenticateAdmin, async (req, res) => {
    const { startDate, endDate, daysToApply } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("DELETE FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 AND status = 'available'", [startDate, endDate]);
        const monitors = await client.query("SELECT id FROM users WHERE role IN ('monitor', 'admin')");
        const defs = await client.query("SELECT start_time, duration_minutes, label FROM slot_definitions");
        
        let curr = new Date(startDate);
        const endLimit = new Date(endDate);
        while (curr <= endLimit) {
            if (daysToApply.map(Number).includes(curr.getDay())) {
                const dateStr = curr.toISOString().split('T')[0];
                for (const m of monitors.rows) {
                    for (const d of defs.rows) {
                        if (d.label === "PAUSE") continue;
                        const startTS = `${dateStr} ${d.start_time}`;
                        await client.query("INSERT INTO slots (start_time, end_time, monitor_id, status) VALUES ($1, $1::timestamp + ($2 || ' minutes')::interval, $3, 'available') ON CONFLICT DO NOTHING", [startTS, d.duration_minutes, m.id]);
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

// --- ROUTES CONFIGURATION ---

app.get('/api/admin/config/slots-definitions', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM slot_definitions ORDER BY start_time ASC");
    res.json(result.rows);
  } catch (err) { res.json([]); }
});

app.post('/api/admin/config/slots-definitions', authenticateAdmin, async (req, res) => {
  const { start_time, duration_minutes, label } = req.body;
  try {
    await pool.query("INSERT INTO slot_definitions (start_time, duration_minutes, label) VALUES ($1, $2, $3)", 
      [start_time, duration_minutes, label || 'LOGISTIQUE + VOL']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/config/slots-definitions/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM slot_definitions WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ message: "Invalide" });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ message: "Invalide" });
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/monitors', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, first_name FROM users WHERE role IN ('monitor', 'admin')");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Serveur sur ${PORT}`));