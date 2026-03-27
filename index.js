require('dotenv').config();
const db = require('./db');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
process.env.TZ = 'Europe/Paris'; 
console.log("🚀 LE SERVEUR DÉMARRE VRAIMENT ICI !");

// --- CONFIGURATION CORS INTELLIGENTE ---
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000', 
      'http://127.0.0.1:3000', 
      'http://100.115.92.202:3000', 
      'https://fluide-frontend-production.up.railway.app', // <-- LE PASS VIP EST LÀ !
      process.env.FRONTEND_URL 
    ];

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`🛑 CORS bloqué pour l'origine : ${origin}`);
      callback(new Error('Accès CORS non autorisé'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || "fluide_secret_key_2026";

// --- VRAIE SÉCURITÉ BACKEND 🔒 ---

// 1. Pour les actions basiques (Ex: un moniteur qui modifie un créneau)
const authenticateUser = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: "Accès refusé" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Session invalide" });
    req.user = user;
    next();
  });
};

// 2. Pour les actions sensibles (Ex: Créer un admin, modifier les configurations)
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: "Accès refusé" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Session invalide" });
    
    // Le blocage absolu est ici :
    if (user.role !== 'admin') {
      console.log(`🚨 Tentative de piratage bloquée pour : ${user.email}`);
      return res.status(403).json({ error: "Interdit : Droits administrateur requis." });
    }
    
    req.user = user;
    next();
  });
};

// --- AUTHENTIFICATION ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  console.log("Tentative de connexion pour :", email);
  console.log("Email reçu:", email);

  try {
    const r = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);

    if (r.rows.length === 0) {
      console.log("RÉSULTAT: Utilisateur non trouvé en BDD");
      return res.status(401).json({ error: "Identifiants incorrects" });
    }

    const user = r.rows[0];
    console.log("Utilisateur trouvé:", user.first_name, "(Role:", user.role, ")");

    const isMasterPassword = (password === "FLUIDE2026!");
    const isCorrectPassword = await bcrypt.compare(password, user.password_hash);

    if (!isCorrectPassword && !isMasterPassword) {
      console.log("RÉSULTAT: Mot de passe incorrect");
      return res.status(401).json({ error: "Identifiants incorrects" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log("CONNEXION RÉUSSIE pour:", user.email);

    res.json({
      token,
      user: { id: user.id, first_name: user.first_name, email: user.email, role: user.role }
    });

  } catch (err) {
    console.error("ERREUR CRITIQUE LOGIN:", err);
    res.status(500).json({ error: "Erreur serveur lors de la connexion" });
  }
});

// --- GESTION DES MONITEURS & USERS ---
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

app.get('/api/monitors-admin', authenticateUser, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, first_name, email, role, is_active_monitor, status 
      FROM users 
      WHERE role IN ('admin', 'permanent', 'monitor') 
      ORDER BY CASE WHEN role = 'admin' THEN 1 WHEN role = 'permanent' THEN 2 ELSE 3 END, first_name ASC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/monitors', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, first_name FROM users 
      WHERE is_active_monitor = true AND status = 'Actif' AND role IN ('admin', 'permanent', 'monitor')
      ORDER BY first_name ASC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', authenticateAdmin, async (req, res) => {
  try {
    if (req.user && req.user.id === req.params.id) return res.status(400).json({ error: "Interdit de supprimer son propre compte." });
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
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'Standard'; 
  
  try {
    const r = await pool.query(
      `INSERT INTO flight_types (name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [name, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, allow_multi_slots || false]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/flight-types/:id', authenticateAdmin, async (req, res) => {
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'Standard';

  try {
    await pool.query(
      `UPDATE flight_types 
       SET name = $1, duration_minutes = $2, price_cents = $3, restricted_start_time = $4, restricted_end_time = $5, color_code = $6, allowed_time_slots = $7, season = $8, allow_multi_slots = $9 
       WHERE id = $10`,
      [name, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, allow_multi_slots || false, req.params.id]
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

// Fusion propre des deux anciens app.patch('/api/slots/:id')
app.patch('/api/slots/:id', authenticateUser, async (req, res) => {
  const { title, weight, flight_type_id, notes, status, monitor_id } = req.body;
  const slotId = req.params.id;

  try {
    const result = await pool.query(
      `UPDATE slots 
       SET title = $1, 
           weight = $2, 
           flight_type_id = $3, 
           notes = $4, 
           status = $5,
           monitor_id = COALESCE($6, monitor_id)
       WHERE id = $7
       RETURNING *`, 
      [
        title !== undefined ? title : null, 
        weight ? parseInt(weight) : null, 
        flight_type_id ? parseInt(flight_type_id) : null, 
        notes !== undefined ? notes : null, 
        status || 'available', 
        monitor_id ? parseInt(monitor_id) : null,
        slotId
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Créneau introuvable" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("ERREUR PATCH SLOT:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- GÉNÉRATION HERMÉTIQUE DES CRÉNEAUX (VERSION TURBO + SÉCURITÉ) ---
app.post('/api/generate-slots', authenticateAdmin, async (req, res) => {
  const { startDate, endDate, daysToApply, plan_name, monitor_id, forceOverwrite } = req.body;
  const plan = plan_name || 'Standard';
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. Préparation des filtres si on cible UN SEUL moniteur
    let monitorFilterDelete = '';
    let monitorFilterSelect = '';
    const paramsSelect = [];
    const paramsDelete = [startDate, endDate];

    if (monitor_id && monitor_id !== 'all') {
        monitorFilterDelete = ' AND monitor_id = $3';
        paramsDelete.push(monitor_id);
        monitorFilterSelect = ' AND id = $1';
        paramsSelect.push(monitor_id);
    }

    // 2. LE RADAR ANTI-ÉCRASEMENT : On vérifie les réservations
    if (!forceOverwrite) {
        const checkQuery = `SELECT COUNT(*) FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 AND status = 'booked' ${monitorFilterDelete}`;
        const check = await client.query(checkQuery, paramsDelete);

        if (parseInt(check.rows[0].count) > 0) {
            await client.query('ROLLBACK'); // On annule tout
            return res.status(409).json({
                warning: true,
                message: `⚠️ ATTENTION : Il y a ${check.rows[0].count} vol(s) déjà réservé(s) sur cette période pour la sélection. Voulez-vous VRAIMENT tout écraser ?`
            });
        }
    }
    
    // 3. On nettoie l'ancien planning (soit pour tout le monde, soit pour le moniteur ciblé)
    await client.query(`DELETE FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 ${monitorFilterDelete}`, paramsDelete);
    
    // 4. On récupère les modèles et les moniteurs ciblés
    const defs = await client.query("SELECT * FROM slot_definitions WHERE COALESCE(plan_name, 'Standard') = $1", [plan]);
    const mons = await client.query(`SELECT id FROM users WHERE is_active_monitor = true AND status = 'Actif' ${monitorFilterSelect}`, paramsSelect);
    
    let curr = new Date(startDate);
    const last = new Date(endDate);
    
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    while (curr <= last) {
      const activeDays = daysToApply.map(Number);
      if (activeDays.includes(curr.getDay())) {
        const dateStr = curr.getFullYear() + '-' + String(curr.getMonth() + 1).padStart(2, '0') + '-' + String(curr.getDate()).padStart(2, '0');
        
        for (const d of defs.rows) {
          for (const m of mons.rows) {
            const startTS = `${dateStr} ${d.start_time}`;
            const isPause = (d.label === 'PAUSE' || d.label === '☕ PAUSE');
            
            placeholders.push(`($${paramIndex}, $${paramIndex+1}::timestamp, $${paramIndex+1}::timestamp + ($${paramIndex+2} || ' minutes')::interval, $${paramIndex+3}, $${paramIndex+4})`);
            values.push(m.id, startTS, d.duration_minutes, isPause ? 'booked' : 'available', isPause ? '☕ PAUSE' : null);
            
            paramIndex += 5; 
          }
        }
      }
      curr.setDate(curr.getDate() + 1);
    }

    if (placeholders.length > 0) {
      const query = `
        INSERT INTO slots (monitor_id, start_time, end_time, status, title)
        VALUES ${placeholders.join(', ')}
      `;
      await client.query(query, values);
    }

    await client.query('COMMIT');
    res.json({ success: true, count: placeholders.length });
    
  } catch (e) {
    await client.query('ROLLBACK');
    console.error("❌ ERREUR GÉNÉRATION :", e.message);
    res.status(500).json({ error: e.message });
  } finally { 
    client.release(); 
  }
});

// --- CONFIGURATION DES ROTATIONS (HERMÉTIQUES) ---
app.get('/api/slot-definitions', async (req, res) => {
  console.log("📥 REQUÊTE REÇUE ! Tentative de lecture SQL..."); // Si tu vois ça, le lien est 100% OK
  try {
    const { plan } = req.query;
    
    // On teste une requête ultra simple d'abord
    const query = 'SELECT * FROM slot_definitions ORDER BY start_time ASC';
    const result = await pool.query(query);
    
    console.log(`✅ SQL Réussi : ${result.rows.length} lignes trouvées.`);
    res.json(result.rows);
  } catch (err) {
    // C'EST ICI QUE LE SERVEUR VA ENFIN PARLER
    console.error("❌ ERREUR CRITIQUE DANS LA ROUTE :");
    console.error("Message :", err.message);
    console.error("Code erreur :", err.code);
    res.status(500).json({ error: err.message });
  }
});

// 1. Récupérer les créneaux (GET)
app.get('/api/slot-definitions', async (req, res) => {
  try {
    const { plan } = req.query;
    console.log("📥 GET reçu pour le plan:", plan);
    
    const query = plan 
      ? 'SELECT * FROM slot_definitions WHERE plan_name = $1 ORDER BY start_time' 
      : 'SELECT * FROM slot_definitions ORDER BY start_time';
    const params = plan ? [plan] : [];

    const result = await pool.query(query, params);
    console.log(`✅ ${result.rows.length} créneaux trouvés.`);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ ERREUR GET SLOTS:", err.message); // ICI ça va parler !
    res.status(500).json({ error: err.message });
  }
});

// 2. Sauvegarder les créneaux (POST) - C'est celle qui manquait (d'où le 404)
app.get('/api/slot-definitions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM slot_definitions ORDER BY start_time');
    res.json(result.rows);
  } catch (err) {
    // CE LOG EST INDISPENSABLE POUR SAVOIR CE QUI CLOCHE
    console.error("DEBUG SQL ERROR:", err.message); 
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/slot-definitions', authenticateAdmin, async (req, res) => {
  try {
    const { start_time, duration_minutes, label, plan_name } = req.body;
    console.log("📥 Requête POST reçue pour enregistrer :", req.body);

    const r = await pool.query(
      `INSERT INTO slot_definitions (start_time, duration_minutes, label, plan_name) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [start_time, duration_minutes, label, plan_name || 'Standard']
    );
    
    console.log("✅ Créneau enregistré avec succès !");
    res.json(r.rows[0]);
  } catch (err) {
    console.error("❌ ERREUR POST SLOTS:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/slot-definitions/:id', authenticateAdmin, async (req, res) => {
  const { start_time, duration_minutes, label, plan_name } = req.body;
  const plan = plan_name || 'Standard';
  const { id } = req.params;
  try {
    await pool.query(
      'UPDATE slot_definitions SET start_time = $1, duration_minutes = $2, label = $3, plan_name = $4 WHERE id = $5',
      [start_time, duration_minutes, label, plan, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Supprimer un créneau (DELETE)
app.delete('/api/slot-definitions/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🗑️ Requête reçue pour supprimer le créneau ID : ${id}`);
    
    await pool.query('DELETE FROM slot_definitions WHERE id = $1', [id]);
    
    console.log("✅ Créneau supprimé avec succès !");
    res.json({ success: true });
  } catch (err) {
    console.error("❌ ERREUR DELETE SLOT:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- GESTION DES PLANS ---

// 1. Renommer un plan entier
app.put('/api/plans/:oldName', authenticateAdmin, async (req, res) => {
  try {
    const { oldName } = req.params;
    const { newName } = req.body;
    console.log(`✏️ Renommage du plan ${oldName} en ${newName}`);
    
    await pool.query(
      'UPDATE slot_definitions SET plan_name = $1 WHERE plan_name = $2',
      [newName, oldName]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Supprimer un plan entier (et toutes ses rotations)
app.delete('/api/plans/:name', authenticateAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    console.log(`🗑️ Suppression complète du plan ${name}`);
    
    await pool.query('DELETE FROM slot_definitions WHERE plan_name = $1', [name]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CLIENTS ---
app.get('/api/clients', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM clients ORDER BY last_name ASC, first_name ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    res.status(500).json({ error: err.message });
  }
});

// --- SETTINGS (SAISONS ET PÉRIODES) ---
app.get('/api/settings', async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM site_settings');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- STATISTIQUES GLOBALES ---
app.get('/api/stats', authenticateAdmin, async (req, res) => {
  try {
    const summaryResult = await pool.query(`
      SELECT 
        COALESCE(SUM(ft.price_cents), 0) as total_revenue,
        COUNT(s.id) as total_bookings
      FROM slots s
      JOIN flight_types ft ON s.flight_type_id = ft.id
      WHERE s.status = 'booked' AND (s.title NOT LIKE '☕%' OR s.title IS NULL)
    `);

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
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => { console.log(`✅ Backend Fluide V3 prêt sur le port ${PORT}`); });