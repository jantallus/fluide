const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION BASE DE DONNÉES ---
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

// --- ROUTES CONFIGURATION (POUR LA PAGE CONFIG) ---

// 1. Définitions des créneaux (Structure Logistique)
app.get('/api/admin/config/slots-definitions', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM slot_definitions ORDER BY start_time ASC");
    res.json(result.rows);
  } catch (err) { res.json([]); }
});

app.post('/api/admin/config/slots-definitions', authenticateAdmin, async (req, res) => {
  const { start_time, duration_minutes, label } = req.body;
  try {
    await pool.query(
      "INSERT INTO slot_definitions (start_time, duration_minutes, label) VALUES ($1, $2, $3)", 
      [start_time, duration_minutes, label || 'LOGISTIQUE + VOL']
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/config/slots-definitions/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM slot_definitions WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Options (Bornes horaires open/close)
app.get('/api/admin/config', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT option_name, value FROM config_options");
    const config = {};
    result.rows.forEach(row => { config[row.option_name] = row.value; });
    res.json(config);
  } catch (err) { res.json({ open_hour: "09:00", close_hour: "17:00" }); }
});

app.put('/api/admin/config/options', authenticateAdmin, async (req, res) => {
  const { option_name, value } = req.body;
  try {
    await pool.query(
      "INSERT INTO config_options (option_name, value) VALUES ($1, $2) ON CONFLICT (option_name) DO UPDATE SET value = $2",
      [option_name, value]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Mise à jour des tarifs
app.put('/api/admin/vols/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE flight_types SET price_cents = $1 WHERE id = $2", [req.body.price_cents, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- GÉNÉRATION DYNAMIQUE (BASÉE SUR LA CONFIG) ---
app.post('/api/admin/appointments/generate', authenticateAdmin, async (req, res) => {
    const { startDate, endDate, daysToApply } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. NETTOYAGE : On supprime les créneaux libres sur la période
        // On ne touche pas aux réservations (status = 'booked')
        await client.query(`
            DELETE FROM slots 
            WHERE start_time::date >= $1::date 
            AND start_time::date <= $2::date 
            AND status = 'available'
        `, [startDate, endDate]);

        // 2. RÉCUPÉRATION DES PARAMÈTRES
        const monitors = await client.query("SELECT id FROM users WHERE role IN ('monitor', 'admin')");
        const defs = await client.query("SELECT start_time, duration_minutes, label FROM slot_definitions ORDER BY start_time ASC");
        
        let currentDate = new Date(startDate);
        const lastDate = new Date(endDate);

        // 3. GÉNÉRATION
        while (currentDate <= lastDate) {
            const dayOfWeek = currentDate.getDay(); 
            if (daysToApply.map(Number).includes(dayOfWeek)) {
                const dateStr = currentDate.toISOString().split('T')[0];

                for (const monitor of monitors.rows) {
                    for (const def of defs.rows) {
                        if (def.label === "PAUSE") continue;
                        const startTS = `${dateStr} ${def.start_time}`;
                        
                        await client.query(`
                            INSERT INTO slots (start_time, end_time, monitor_id, status) 
                            VALUES ($1, $1::timestamp + ($2 || ' minutes')::interval, $3, 'available') 
                            ON CONFLICT DO NOTHING
                        `, [startTS, def.duration_minutes, monitor.id]);
                    }
                }
            }
            currentDate.setDate(currentDate.getDate() + 1);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: "Planning mis à jour" });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// --- TOUTES TES AUTRES ROUTES (PLANNING, BONS CADEAUX, ETC.) ---

app.get('/api/vols', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flight_types ORDER BY price_cents ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ message: "Identifiants invalides" });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ message: "Identifiants invalides" });
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/appointments', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (s.id)
        s.id::text as id, s.monitor_id as "resourceId", 
        CASE WHEN s.status = 'available' THEN '' ELSE COALESCE(b.customer_name, s.title, '') END as title, 
        date_trunc('minute', s.start_time) as start, date_trunc('minute', s.end_time) as end,
        s.notes, s.status,
        CASE WHEN s.status = 'booked' THEN '#6366f1' WHEN s.status = 'unavailable' THEN '#94a3b8' ELSE '#0ea5e9' END as "backgroundColor"
      FROM slots s LEFT JOIN bookings b ON s.id = b.slot_id
      ORDER BY s.id, b.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/appointments/:id', authenticateAdmin, async (req, res) => {
    const { title, notes, status, monitorId } = req.body;
    try {
        await pool.query("UPDATE slots SET title = $1, notes = $2, status = $3, monitor_id = $4 WHERE id = $5", [title, notes, status || 'booked', monitorId || null, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/appointments/:id/clear', authenticateAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM bookings WHERE slot_id = $1', [req.params.id]);
        await client.query("UPDATE slots SET status = 'available', title = '', notes = '' WHERE id = $1", [req.params.id]);
        await client.query('COMMIT');
        res.json({ message: "Créneau libéré" });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
    finally { client.release(); }
});

app.get('/api/monitors', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, first_name, last_name, role FROM users WHERE role IN ('monitor', 'admin')");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gift-cards', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT gc.*, ft.name as flight_name FROM gift_cards gc JOIN flight_types ft ON gc.flight_type_id = ft.id ORDER BY gc.created_at DESC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', authenticateAdmin, (req, res) => res.json({ totalBookings: 0, revenue: 0 }));
app.get('/api/admin/clients', authenticateAdmin, (req, res) => res.json([]));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Serveur Fluide sur port ${PORT}`));