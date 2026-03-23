require('dotenv').config();
const db = require('./db');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
process.env.TZ = 'Europe/Paris'; 

// --- CONFIGURATION CORS RENFORCÉE (INDISPENSABLE) ---
app.use(cors({
  origin: '*', // Permet à n'importe quel domaine (ton site) de contacter l'API
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || "fluide_secret_key_2026";

// --- MIDDLEWARE AUTH ---
// index.js (Ligne ~30)
const authenticateAdmin = (req, res, next) => {
  // --- TEST DE SURVIE : ON LAISSE TOUT PASSER ---
  console.log("Passage forcé : Sécurité désactivée");
  next(); 
  
  /* Ancien code (on le garde en commentaire pour plus tard) :
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: "Accès refusé" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ message: "Interdit" });
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Token invalide" });
  }
  */
};

// --- AUTHENTIFICATION (CORRIGÉE SANS RIEN SUPPRIMER DU RESTE) ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  console.log("Tentative de connexion pour :", email);
  console.log("Email reçu:", email);

  try {
    // 1. Recherche de l'utilisateur (on utilise 'r' comme nom de variable)
    // Utilisation de LOWER pour éviter les problèmes de majuscules
    const r = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);

    // 2. Vérification si l'utilisateur existe
    if (r.rows.length === 0) {
      console.log("RÉSULTAT: Utilisateur non trouvé en BDD");
      return res.status(401).json({ error: "Identifiants incorrects" });
    }

    const user = r.rows[0];
    console.log("Utilisateur trouvé:", user.first_name, "(Role:", user.role, ")");

    // 3. Vérification du mot de passe (Bcrypt ou Master Password)
    const isMasterPassword = (password === "FLUIDE2026!");
    const isCorrectPassword = await bcrypt.compare(password, user.password_hash);

    if (!isCorrectPassword && !isMasterPassword) {
      console.log("RÉSULTAT: Mot de passe incorrect");
      return res.status(401).json({ error: "Identifiants incorrects" });
    }

    // 4. Génération du Token JWT
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log("CONNEXION RÉUSSIE pour:", user.email);

    res.json({
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    console.error("ERREUR CRITIQUE LOGIN:", err);
    res.status(500).json({ error: "Erreur serveur lors de la connexion" });
  }
});

// --- GESTION DES MONITEURS & USERS ---
// --- CRÉATION UTILISATEUR (URL SIMPLIFIÉE) ---
app.post('/api/users', authenticateAdmin, async (req, res) => {
  const { first_name, email, password, role, is_active_monitor } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (first_name, email, password_hash, role, is_active_monitor, status) 
       VALUES ($1, $2, $3, $4, $5, 'Actif') RETURNING id, first_name, role`,
      [first_name, email, hash, role, is_active_monitor]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- CHANGEMENT DE RÔLE (URL SIMPLIFIÉE) ---
app.patch('/api/slots/:id', authenticateAdmin, async (req, res) => {
  const { title, weight, flight_type_id, notes, status } = req.body;
  const slotId = req.params.id;

  try {
    // 1. On met à jour sans JAMAIS supprimer
    const result = await pool.query(
      `UPDATE slots 
       SET title = $1, 
           weight = $2, 
           flight_type_id = $3, 
           notes = $4, 
           status = $5 
       WHERE id = $6
       RETURNING *`, // On demande à SQL de renvoyer le créneau mis à jour
      [
        title || null, 
        weight ? parseInt(weight) : null, 
        flight_type_id ? parseInt(flight_type_id) : null, 
        notes || null, 
        status || 'available', 
        slotId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Créneau introuvable" });
    }

    // 2. On renvoie le créneau complet au front pour qu'il ne disparaisse pas
    res.json(result.rows[0]);
    
  } catch (err) {
    console.error("ERREUR PATCH SLOT:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monitors-admin', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, first_name, email, role, is_active_monitor, status 
      FROM users 
      WHERE role IN ('admin', 'permanent', 'monitor') 
      ORDER BY 
        CASE WHEN role = 'admin' THEN 1 WHEN role = 'permanent' THEN 2 ELSE 3 END, 
        first_name ASC
    `);
    res.json(r.rows);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/monitors', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, first_name 
      FROM users 
      WHERE is_active_monitor = true 
      AND status = 'Actif'
      AND role IN ('admin', 'permanent', 'monitor')
      ORDER BY first_name ASC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SUPPRESSION UTILISATEUR (URL SIMPLIFIÉE) ---
app.delete('/api/users/:id', authenticateAdmin, async (req, res) => {
  try {
    // req.user.id vient du token décodé (si sécurité activée)
    if (req.user && req.user.id === req.params.id) {
      return res.status(400).json({ error: "Interdit de supprimer son propre compte." });
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- PRESTATIONS (FLIGHT TYPES) ---
app.get('/api/flight-types', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM flight_types ORDER BY price_cents ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/flight-types', authenticateAdmin, async (req, res) => {
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'ALL'; // Par défaut, valable toute l'année
  
  try {
    const r = await pool.query(
      `INSERT INTO flight_types (name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, duration_minutes, price_cents, start, end, color_code, slots, flightSeason]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/flight-types/:id', authenticateAdmin, async (req, res) => {
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'ALL';

  try {
    await pool.query(
      `UPDATE flight_types 
       SET name = $1, duration_minutes = $2, price_cents = $3, restricted_start_time = $4, restricted_end_time = $5, color_code = $6, allowed_time_slots = $7, season = $8 
       WHERE id = $9`,
      [name, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/flight-types/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM flight_types WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: "Impossible de supprimer ce vol car il est utilisé." }); 
  }
});

// --- COMPLÉMENTS (OPTIONS VOL) ---
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
      'INSERT INTO complements (name, description, price_cents, is_active) VALUES ($1, $2, $3, true) RETURNING *',
      [name, description, price_cents]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/complements/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM complements WHERE id = $1', [req.params.id]);
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
  const { title, notes, status, flight_type_id, weight, monitor_id } = req.body;
  try {
    await pool.query(
      "UPDATE slots SET title = $1, notes = $2, status = $3, flight_type_id = $4, weight = $5, monitor_id = $6 WHERE id = $7",
      [title, notes, status, flight_type_id, weight, monitor_id, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-slots', authenticateAdmin, async (req, res) => {
  const { startDate, endDate, daysToApply } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // On nettoie l'existant sur la période
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

// --- CLIENTS ---
app.get('/api/clients', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM clients ORDER BY last_name ASC, first_name ASC');
    res.json(r.rows);
  } catch (err) {
    console.error("Erreur GET /api/clients:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- BONS CADEAUX ---
app.get('/api/gift-cards', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT gc.*, ft.name as flight_name FROM gift_cards gc 
      LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id 
      ORDER BY gc.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gift-cards', authenticateAdmin, async (req, res) => {
  const { flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes } = req.body;
  const code = "FL-" + Math.random().toString(36).substring(2, 7).toUpperCase();
  try {
    const r = await pool.query(
      `INSERT INTO gift_cards (code, flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes, status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'valid') RETURNING *`,
      [code, parseInt(flight_type_id), buyer_name, beneficiary_name, parseInt(price_paid_cents), notes || null]
    );
    res.json(r.rows[0]);
  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/gift-cards/check/:code', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT gc.*, ft.name as flight_name FROM gift_cards gc 
       JOIN flight_types ft ON gc.flight_type_id = ft.id 
       WHERE UPPER(gc.code) = UPPER($1) AND gc.status = 'valid'`, [req.params.code]
    );
    if (r.rows.length === 0) return res.status(404).json({ message: "Bon invalide ou déjà utilisé" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/gift-cards/:id/status', authenticateAdmin, async (req, res) => {
  const { status } = req.body;
  try {
    await pool.query("UPDATE gift_cards SET status = $1 WHERE id = $2", [status, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- DASHBOARD STATS ---
app.get('/api/dashboard-stats', authenticateAdmin, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
    
    const summary = await pool.query(`
      SELECT 
        COUNT(*) as total_slots, 
        COUNT(*) FILTER (WHERE status = 'booked' AND (title NOT LIKE '☕%' OR title IS NULL)) as booked_slots, 
        COALESCE(SUM(ft.price_cents), 0) as revenue
      FROM slots s 
      LEFT JOIN flight_types ft ON s.flight_type_id = ft.id 
      WHERE s.start_time::date = $1`, [today]);

    const upcoming = await pool.query(`
      SELECT s.id, s.start_time, s.title, ft.name as flight_name, u.first_name as monitor_name, s.notes
      FROM slots s 
      LEFT JOIN flight_types ft ON s.flight_type_id = ft.id 
      LEFT JOIN users u ON s.monitor_id = u.id
      WHERE s.start_time::date = $1 
      AND s.status = 'booked' 
      AND (s.title NOT LIKE '☕%' OR s.title IS NULL) 
      AND s.start_time >= (NOW() AT TIME ZONE 'Europe/Paris') 
      ORDER BY s.start_time ASC 
      LIMIT 5`, [today]);

    res.json({
      summary: { 
        todaySlots: parseInt(summary.rows[0].total_slots) || 0, 
        bookedSlots: parseInt(summary.rows[0].booked_slots) || 0, 
        revenue: parseInt(summary.rows[0].revenue) || 0 
      },
      upcoming: upcoming.rows
    });
  } catch (err) {
    console.error("Erreur Dashboard:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- CONFIGURATION : SAISON (Dates de début et fin) ---
app.get('/api/settings', async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM site_settings');
    // Renvoie un tableau [{key: 'season_start', value: '...'}, ...]
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', authenticateAdmin, async (req, res) => {
  const { key, value } = req.body;
  try {
    await pool.query(
      `INSERT INTO site_settings (key, value) VALUES ($1, $2) 
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CONFIGURATION : MODIFIER UNE ROTATION EXISTANTE (PUT) ---
app.put('/api/slot-definitions/:id', authenticateAdmin, async (req, res) => {
  const { start_time, duration_minutes, label } = req.body;
  const { id } = req.params;
  try {
    await pool.query(
      'UPDATE slot_definitions SET start_time = $1, duration_minutes = $2, label = $3 WHERE id = $4',
      [start_time, duration_minutes, label, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- COMPLÉMENTS (OPTIONS SUPPLÉMENTAIRES) ---
app.get('/api/complements', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM complements WHERE is_active = true ORDER BY price_cents ASC');
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- STATISTIQUES GLOBALES ---
app.get('/api/stats', authenticateAdmin, async (req, res) => {
  try {
    // 1. Calcul du CA global et nombre de vols
    const summaryResult = await pool.query(`
      SELECT 
        COALESCE(SUM(ft.price_cents), 0) as total_revenue,
        COUNT(s.id) as total_bookings
      FROM slots s
      JOIN flight_types ft ON s.flight_type_id = ft.id
      WHERE s.status = 'booked' AND (s.title NOT LIKE '☕%' OR s.title IS NULL)
    `);

    // 2. Liste des sessions à venir (pour le tableau)
    const upcomingResult = await pool.query(`
      SELECT 
        s.id, s.start_time, s.title as client_name, 
        ft.name as flight_name, ft.price_cents as total_price,
        u.first_name as monitor_name
      FROM slots s
      JOIN flight_types ft ON s.flight_type_id = ft.id
      LEFT JOIN users u ON s.monitor_id = u.id
      WHERE s.status = 'booked' 
      AND s.start_time >= NOW()
      ORDER BY s.start_time ASC
    `);

    res.json({
      summary: {
        totalRevenue: parseInt(summaryResult.rows[0].total_revenue),
        totalBookings: parseInt(summaryResult.rows[0].total_bookings)
      },
      upcoming: upcomingResult.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DÉMARRAGE ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`✅ Backend Fluide V3 prêt sur le port ${PORT}`); });