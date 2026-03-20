const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || "fluide_secret_key_2026";

// --- MIDDLEWARE AUTH ---
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

// --- ROUTES UTILISATEURS & AUTH ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = r.rows[0];
    if (user && await bcrypt.compare(password, user.password_hash)) {
      const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET);
      res.json({ token, user: { id: user.id, role: user.role, first_name: user.first_name } });
    } else {
      res.status(401).json({ message: "Identifiants invalides" });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/monitors', async (req, res) => {
  try {
    const r = await pool.query("SELECT id, first_name FROM users WHERE is_active_monitor = true AND status = 'Actif'");
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ROUTES PLANNING & VOLS ---
app.get('/api/flight-types', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM flight_types ORDER BY price_cents ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/appointments', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, ft.name as flight_name, ft.color_code, u.first_name as monitor_name 
      FROM slots s
      LEFT JOIN flight_types ft ON s.flight_type_id = ft.id
      LEFT JOIN users u ON s.monitor_id = u.id
      ORDER BY s.start_time ASC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- GÉNÉRATION DES CRÉNEAUX (L'INTELLIGENCE) ---
app.post('/api/admin/generate-slots', authenticateAdmin, async (req, res) => {
  const { startDate, endDate, daysToApply } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const defs = await client.query('SELECT * FROM slot_definitions');
    const mons = await client.query("SELECT id FROM users WHERE is_active_monitor = true AND status = 'Actif'");
    
    let curr = new Date(startDate);
    const last = new Date(endDate);

    while (curr <= last) {
      if (daysToApply.map(Number).includes(curr.getDay())) {
        const dateStr = curr.toLocaleDateString('en-CA'); // Format YYYY-MM-DD local

        for (const d of defs.rows) {
          for (const m of mons.rows) {
            const startTS = `${dateStr} ${d.start_time}`;
            const isPause = d.label === 'PAUSE';

            await client.query(`
              INSERT INTO slots (monitor_id, start_time, end_time, status, title)
              VALUES ($1, $2, $2::timestamp + ($3 || ' minutes')::interval, $4, $5)
              ON CONFLICT (monitor_id, start_time) DO NOTHING
            `, [m.id, startTS, isPause ? 59 : d.duration_minutes, isPause ? 'booked' : 'available', isPause ? '☕ PAUSE' : null]);
          }
        }
      }
      curr.setDate(curr.getDate() + 1);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) { 
    await client.query('ROLLBACK'); 
    res.status(500).json({ error: e.message }); 
  } finally { client.release(); }
});

// Créer une nouvelle prestation
app.post('/api/flight-types', authenticateAdmin, async (req, res) => {
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO flight_types (name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Supprimer une prestation
app.delete('/api/flight-types/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM flight_types WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/complements', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM complements WHERE is_active = true ORDER BY price_cents ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/complements', authenticateAdmin, async (req, res) => {
  const { name, description, price_cents } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO complements (name, description, price_cents) VALUES ($1, $2, $3) RETURNING *',
      [name, description, price_cents]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- MISE À JOUR / RÉSERVATION ---
app.put('/api/appointments/:id', authenticateAdmin, async (req, res) => {
  const { title, notes, status, flight_type_id } = req.body;
  try {
    await pool.query(
      "UPDATE slots SET title = $1, notes = $2, status = $3, flight_type_id = $4 WHERE id = $5",
      [title, notes, status, flight_type_id, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 1. Récupérer TOUS les moniteurs et admins (pour la gestion)
app.get('/api/monitors-admin', async (req, res) => {
  try {
    const r = await pool.query("SELECT id, first_name, email, role, is_active_monitor FROM users WHERE role IN ('monitor', 'admin') ORDER BY first_name ASC");
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Switcher le statut actif d'un moniteur
app.patch('/api/monitors/:id/toggle-active', async (req, res) => {
  const { is_active_monitor } = req.body;
  try {
    await pool.query("UPDATE users SET is_active_monitor = $1 WHERE id = $2", [is_active_monitor, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ROUTES CLIENTS ---
app.get('/api/clients', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT * FROM clients 
      ORDER BY last_name ASC, first_name ASC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ROUTES BONS CADEAUX (COUPONS) ---
app.get('/api/gift-cards', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT gc.*, ft.name as flight_name 
      FROM gift_cards gc
      LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id
      ORDER BY gc.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer toutes les définitions
app.get('/api/slot-definitions', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM slot_definitions ORDER BY start_time ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ajouter une nouvelle définition de rotation
app.post('/api/slot-definitions', async (req, res) => {
  const { start_time, duration_minutes, label } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO slot_definitions (start_time, duration_minutes, label) VALUES ($1, $2, $3) RETURNING *',
      [start_time, duration_minutes, label]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Supprimer une définition
app.delete('/api/slot-definitions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM slot_definitions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Récupérer tous les réglages
app.get('/api/settings', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM site_settings');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Enregistrer ou mettre à jour un réglage
app.post('/api/settings', authenticateAdmin, async (req, res) => {
  const { key, value } = req.body;
  try {
    await pool.query(
      'INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, value]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/dashboard-stats', authenticateAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Résumé de la journée
    const summary = await pool.query(`
      SELECT 
        COUNT(*) as total_slots,
        COUNT(*) FILTER (WHERE status = 'booked' AND title NOT LIKE '☕%') as booked_slots,
        COALESCE(SUM(ft.price_cents) FILTER (WHERE s.status = 'booked'), 0) as revenue
      FROM slots s
      LEFT JOIN flight_types ft ON s.flight_type_id = ft.id
      WHERE s.start_time::date = $1
    `, [today]);

    // Les 5 prochains vols
    const upcoming = await pool.query(`
      SELECT s.*, ft.name as flight_name, u.first_name as monitor_name
      FROM slots s
      LEFT JOIN flight_types ft ON s.flight_type_id = ft.id
      LEFT JOIN users u ON s.monitor_id = u.id
      WHERE s.start_time::date = $1 AND s.status = 'booked' AND s.title NOT LIKE '☕%'
      ORDER BY s.start_time ASC
      LIMIT 5
    `, [today]);

    res.json({
      summary: {
        todaySlots: parseInt(summary.rows[0].total_slots),
        bookedSlots: parseInt(summary.rows[0].booked_slots),
        revenue: parseInt(summary.rows[0].revenue)
      },
      upcoming: upcoming.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- DÉMARRAGE ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log(`✅ Backend Fluide V3 prêt sur le port ${PORT}`); });