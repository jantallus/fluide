const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
process.env.TZ = 'Europe/Paris'; // Force le serveur à l'heure de Paris
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

// --- AUTHENTIFICATION ---
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

// --- GESTION DES MONITEURS & USERS ---

// Créer un nouvel utilisateur (Admin ou Moniteur)
app.post('/api/admin/users', authenticateAdmin, async (req, res) => {
  const { first_name, email, password, role, is_active_monitor } = req.body;
  
  try {
    // Vérification si l'utilisateur existe déjà
    const checkUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ error: "Cet email est déjà utilisé." });
    }

    // Chiffrement du mot de passe
    const saltRounds = 10;
    const hash = await bcrypt.hash(password, saltRounds);

    const r = await pool.query(
      `INSERT INTO users (first_name, email, password_hash, role, is_active_monitor, status) 
       VALUES ($1, $2, $3, $4, $5, 'Actif') RETURNING id, first_name, email, role`,
      [first_name, email, hash, role || 'monitor', is_active_monitor]
    );
    
    res.json(r.rows[0]);
  } catch (err) {
    console.error("Erreur création utilisateur:", err.message);
    res.status(500).json({ error: "Erreur serveur lors de la création." });
  }
});

// Changer le rôle d'un utilisateur
app.patch('/api/admin/users/:id/role', authenticateAdmin, async (req, res) => {
  const { role } = req.body;
  try {
    await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/monitors', async (req, res) => {
  try {
    const r = await pool.query("SELECT id, first_name FROM users WHERE is_active_monitor = true AND status = 'Actif'");
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/monitors-admin', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT id, first_name, email, role, is_active_monitor FROM users WHERE role IN ('monitor', 'admin') ORDER BY first_name ASC");
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/monitors/:id/toggle-active', authenticateAdmin, async (req, res) => {
  const { is_active_monitor } = req.body;
  try {
    await pool.query("UPDATE users SET is_active_monitor = $1 WHERE id = $2", [is_active_monitor, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Supprimer un utilisateur
app.delete('/api/admin/users/:id', authenticateAdmin, async (req, res) => {
  try {
    // On vérifie qu'on ne se supprime pas soi-même (sécurité)
    if (req.user.id === parseInt(req.params.id)) {
      return res.status(400).json({ error: "Vous ne pouvez pas supprimer votre propre compte admin." });
    }

    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Erreur suppression utilisateur:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- PRESTATIONS (FLIGHT TYPES) ---
app.get('/api/flight-types', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM flight_types ORDER BY price_cents ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/flight-types', authenticateAdmin, async (req, res) => {
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  try {
    const r = await pool.query(
      `INSERT INTO flight_types (name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, duration_minutes, price_cents, start, end, color_code]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/flight-types/:id', authenticateAdmin, async (req, res) => {
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  try {
    await pool.query(
      `UPDATE flight_types SET name = $1, duration_minutes = $2, price_cents = $3, restricted_start_time = $4, restricted_end_time = $5, color_code = $6 WHERE id = $7`,
      [name, duration_minutes, price_cents, start, end, color_code, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/flight-types/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM flight_types WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- PLANNING & SLOTS ---
app.get('/api/slots', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM slots ORDER BY start_time ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/slots/:id', authenticateAdmin, async (req, res) => {
  const { title, notes, status, flight_type_id, weight, gift_code } = req.body; // Ajoutez gift_code ici
  
  try {
    // 1. On met à jour le créneau dans le planning
    await pool.query(
      "UPDATE slots SET title = $1, notes = $2, status = $3, flight_type_id = $4, weight = $5 WHERE id = $6",
      [title, notes, status, flight_type_id, weight, req.params.id]
    );

    // 2. Si un code de bon cadeau est fourni, on le marque comme utilisé
    if (gift_code) {
      await pool.query(
        "UPDATE gift_cards SET status = 'used' WHERE UPPER(code) = UPPER($1)",
        [gift_code]
      );
    }

    res.json({ success: true });
  } catch (e) { 
    console.error("Erreur lors de la mise à jour du créneau:", e.message);
    res.status(500).json({ error: e.message }); 
  }
});

app.post('/api/admin/generate-slots', authenticateAdmin, async (req, res) => {
  const { startDate, endDate, daysToApply } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2`, [startDate, endDate]);
    const defs = await client.query('SELECT * FROM slot_definitions');
    const mons = await client.query("SELECT id FROM users WHERE is_active_monitor = true AND status = 'Actif'");
    let curr = new Date(startDate);
    const last = new Date(endDate);
    while (curr <= last) {
      const activeDays = daysToApply.map(Number);
      if (activeDays.includes(curr.getDay())) {
        const dateStr = curr.getFullYear() + '-' + String(curr.getMonth() + 1).padStart(2, '0') + '-' + String(curr.getDate()).padStart(2, '0');
        for (const d of defs.rows) {
          for (const m of mons.rows) {
            const startTS = `${dateStr} ${d.start_time}`;
            const isPause = (d.label === 'PAUSE' || d.label === '☕ PAUSE');
            await client.query(`
              INSERT INTO slots (monitor_id, start_time, end_time, status, title)
              VALUES ($1, $2::timestamp, $2::timestamp + ($3 || ' minutes')::interval, $4, $5)
            `, [m.id, startTS, d.duration_minutes, isPause ? 'booked' : 'available', isPause ? '☕ PAUSE' : null]);
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

// --- CONFIGURATION DES ROTATIONS (SLOT DEFINITIONS) ---
app.get('/api/slot-definitions', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM slot_definitions ORDER BY start_time ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/slot-definitions', authenticateAdmin, async (req, res) => {
  const { start_time, duration_minutes, label } = req.body;
  try {
    const [h, m] = start_time.split(':').map(Number);
    const newStart = h * 60 + m;
    const newEnd = newStart + parseInt(duration_minutes);
    const existing = await pool.query('SELECT start_time, duration_minutes, label FROM slot_definitions');
    for (let row of existing.rows) {
      const [exH, exM] = row.start_time.split(':').map(Number);
      const exStart = exH * 60 + exM;
      const exEnd = exStart + row.duration_minutes;
      if (newStart < exEnd && newEnd > exStart) {
        return res.status(400).json({ error: `Conflit avec la rotation "${row.label}" (${row.start_time})` });
      }
    }
    const r = await pool.query('INSERT INTO slot_definitions (start_time, duration_minutes, label) VALUES ($1, $2, $3) RETURNING *', [start_time, duration_minutes, label]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/slot-definitions/:id', authenticateAdmin, async (req, res) => {
  const { start_time, duration_minutes, label } = req.body;
  try {
    await pool.query('UPDATE slot_definitions SET start_time = $1, duration_minutes = $2, label = $3 WHERE id = $4', [start_time, duration_minutes, label, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/slot-definitions/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM slot_definitions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- CLIENTS ---
app.get('/api/clients', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM clients ORDER BY last_name ASC, first_name ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/clients', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM clients ORDER BY last_name ASC, first_name ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- COMPLÉMENTS ---
// Lister tous les compléments (Admin)
app.get('/api/admin/complements', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM complements ORDER BY price_cents ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ajouter un complément
app.post('/api/complements', authenticateAdmin, async (req, res) => {
  const { name, description, price_cents } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO complements (name, description, price_cents, is_active) VALUES ($1, $2, $3, true) RETURNING *',
      [name, description, price_cents]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Supprimer un complément
app.delete('/api/complements/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM complements WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SECTION : BONS CADEAUX ---

// 1. Lister tous les bons (Admin)
app.get('/api/gift-cards', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT gc.*, ft.name as flight_name 
      FROM gift_cards gc 
      LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id 
      ORDER BY gc.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Créer un bon cadeau
app.post('/api/gift-cards', authenticateAdmin, async (req, res) => {
  const { flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes } = req.body;
  const code = "FL-" + Math.random().toString(36).substring(2, 7).toUpperCase();
  
  try {
    const r = await pool.query(
      `INSERT INTO gift_cards (code, flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes, status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'valid') RETURNING *`, // <-- On force 'valid' ici
      [
        code, 
        parseInt(flight_type_id), 
        buyer_name, 
        beneficiary_name, 
        parseInt(price_paid_cents), 
        notes || null
      ]
    );
    res.json(r.rows[0]);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// 3. Vérifier un bon (pour le planning)
app.get('/api/gift-cards/check/:code', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT gc.*, ft.name as flight_name 
       FROM gift_cards gc 
       JOIN flight_types ft ON gc.flight_type_id = ft.id 
       WHERE gc.code = $1 AND gc.status = 'valid'`, 
      [req.params.code.toUpperCase()]
    );
    if (r.rows.length === 0) return res.status(404).json({ message: "Bon invalide ou déjà utilisé" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Annuler ou Forcer le statut d'un bon cadeau
app.patch('/api/gift-cards/:id/status', authenticateAdmin, async (req, res) => {
  const { status } = req.body; // 'valid' ou 'used'
  try {
    await pool.query(
      "UPDATE gift_cards SET status = $1 WHERE id = $2",
      [status, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RÉGLAGES DU SITE ---
app.get('/api/settings', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM site_settings');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', authenticateAdmin, async (req, res) => {
  const { key, value } = req.body;
  try {
    await pool.query('INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- DASHBOARD ---
app.get('/api/admin/dashboard-stats', authenticateAdmin, async (req, res) => {
  try {
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
    const summary = await pool.query(`
      SELECT COUNT(*) as total_slots, COUNT(*) FILTER (WHERE status = 'booked' AND (title NOT LIKE '☕%' OR title IS NULL)) as booked_slots, COALESCE(SUM(ft.price_cents), 0) as revenue
      FROM slots s LEFT JOIN flight_types ft ON s.flight_type_id = ft.id WHERE s.start_time::date = $1 AND s.status = 'booked'`, [today]);
    const totalToday = await pool.query(`SELECT COUNT(*) as count FROM slots WHERE start_time::date = $1`, [today]);
    const upcoming = await pool.query(`
      SELECT s.*, ft.name as flight_name, u.first_name as monitor_name FROM slots s LEFT JOIN flight_types ft ON s.flight_type_id = ft.id LEFT JOIN users u ON s.monitor_id = u.id
      WHERE s.start_time::date = $1 AND s.status = 'booked' AND (s.title NOT LIKE '☕%' OR s.title IS NULL) AND s.start_time >= (NOW() AT TIME ZONE 'Europe/Paris') ORDER BY s.start_time ASC LIMIT 5`, [today]);
    res.json({
      summary: { todaySlots: parseInt(totalToday.rows[0].count), bookedSlots: parseInt(summary.rows[0].booked_slots), revenue: parseInt(summary.rows[0].revenue) },
      upcoming: upcoming.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- DÉMARRAGE ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log(`✅ Backend Fluide V3 prêt sur le port ${PORT}`); });