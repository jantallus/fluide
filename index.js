const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION BASE DE DONNÉES (Adapté Railway) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:fuQIzafUNCSMkwiUNeWZKSoMHwfXutDC@yamanote.proxy.rlwy.net:35258/railway",
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || "fluide_secret_key_2026";

// --- MIDDLEWARE DE SÉCURITÉ ---
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

// --- ROUTES ---

app.get('/api/vols', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flight_types ORDER BY price_cents ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/monitors', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, first_name FROM users WHERE role IN ('monitor', 'admin') AND status = 'Actif'");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/appointments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.id::text as id, 
        s.monitor_id as "resourceId", 
        s.title, 
        s.start_time as start, 
        s.end_time as end,
        s.notes,
        s.status
      FROM slots s ORDER BY s.start_time ASC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/generate-slots', authenticateAdmin, async (req, res) => {
    const { startDate, endDate, daysToApply } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const definitions = await client.query('SELECT * FROM slot_definitions');
      const monitors = await client.query("SELECT id FROM users WHERE role IN ('monitor', 'admin') AND status = 'Actif'");
      
      let currentDate = new Date(startDate);
      const lastDate = new Date(endDate);
  
      while (currentDate <= lastDate) {
        if (daysToApply.map(Number).includes(currentDate.getDay())) {
          const dateStr = currentDate.toISOString().split('T')[0];
          for (const def of definitions.rows) {
            for (const mon of monitors.rows) {
              const startStr = `${dateStr} ${def.start_time}`;
              await client.query(`
                INSERT INTO slots (monitor_id, start_time, end_time, status) 
                VALUES ($1, $2, $2::timestamp + ($3 || ' minutes')::interval, 'available')
                ON CONFLICT (monitor_id, start_time) DO UPDATE SET end_time = EXCLUDED.end_time
              `, [mon.id, startStr, def.duration_minutes]);
            }
          }
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally { client.release(); }
});

app.put('/api/appointments/:id', authenticateAdmin, async (req, res) => {
  const { monitorId, title, status, notes } = req.body;
  try {
    await pool.query(
      `UPDATE slots SET monitor_id = COALESCE($1, monitor_id), title = $2, status = $3, notes = $4 WHERE id = $5`,
      [monitorId, title, status, notes, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  if (r.rows[0] && await bcrypt.compare(password, r.rows[0].password_hash)) {
    const token = jwt.sign({ id: r.rows[0].id, role: r.rows[0].role }, JWT_SECRET);
    res.json({ token, user: { id: r.rows[0].id, role: r.rows[0].role } });
  } else res.status(401).json({ message: "Erreur" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log(`✅ Backend sur port ${PORT}`); });