const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION BASE DE DONNÉES ---
// Utilise DATABASE_URL sur Railway, sinon l'URL de secours
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:fuQIzafUNCSMkwiUNeWZKSoMHwfXutDC@yamanote.proxy.rlwy.net:35258/railway",
  ssl: { rejectUnauthorized: false }
});

// Utilise une variable d'environnement pour le secret JWT
const JWT_SECRET = process.env.JWT_SECRET || "fluide_secret_key_2026";

// --- MIDDLEWARE DE SÉCURITÉ ---
const authenticateAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: "Accès refusé. Token manquant." });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: "Accès interdit. Droits insuffisants." });
    }
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: "Token invalide ou expiré." });
  }
};

// --- ROUTES PUBLIQUES (CLIENT) ---

// Récupérer les créneaux disponibles pour les clients
app.get('/api/slots', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, start_time, end_time, monitor_id 
      FROM slots 
      WHERE status = 'available' AND start_time > NOW()
      ORDER BY start_time ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer les types de vols
app.get('/api/vols', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flight_types ORDER BY price_cents ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login Admin
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ROUTES ADMIN (SÉCURISÉES) ---

// Récupérer tous les rendez-vous pour le planning admin
app.get('/api/appointments', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (s.id)
        s.id::text as id, 
        s.monitor_id as "resourceId", 
        CASE 
          WHEN s.status = 'available' THEN '' 
          ELSE COALESCE(b.customer_name, s.title, '') 
        END as title, 
        date_trunc('minute', s.start_time) as start, 
        date_trunc('minute', s.end_time) as end,
        s.notes,
        s.status,
        EXTRACT(EPOCH FROM (s.end_time - s.start_time))/60 as duration,
        CASE 
          WHEN s.status = 'booked' THEN '#6366f1' 
          WHEN s.status = 'unavailable' THEN '#94a3b8' 
          ELSE '#0ea5e9' 
        END as "backgroundColor"
      FROM slots s 
      LEFT JOIN bookings b ON s.id = b.slot_id
      ORDER BY s.id, b.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mettre à jour un créneau (Titre, Notes, Moniteur, Statut)
app.put('/api/appointments/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { title, notes, status, monitorId } = req.body;
    try {
        const result = await pool.query(
            `UPDATE slots 
             SET title = $1, notes = $2, status = $3, monitor_id = $4 
             WHERE id = $5 RETURNING *`,
            [title, notes, status || 'booked', monitorId || null, id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// LIBÉRER UN CRÉNEAU (Supprime la réservation mais garde le slot)
app.put('/api/appointments/:id/clear', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM bookings WHERE slot_id = $1', [id]);
        const result = await client.query(
            "UPDATE slots SET status = 'available', title = '', notes = '' WHERE id = $1 RETURNING *",
            [id]
        );
        await client.query('COMMIT');
        res.json({ message: "Créneau libéré", slot: result.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Récupérer les moniteurs
app.get('/api/monitors', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, first_name, last_name, role FROM users WHERE role IN ('monitor', 'admin')");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Générer des créneaux pour une journée
app.post('/api/admin/appointments/generate', authenticateAdmin, async (req, res) => {
  const { date, startTime, endTime, intervalMinutes, monitorIds } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const mId of monitorIds) {
      let current = new Date(`${date}T${startTime}`);
      const end = new Date(`${date}T${endTime}`);
      while (current < end) {
        const slotEnd = new Date(current.getTime() + intervalMinutes * 60000);
        await client.query(
          'INSERT INTO slots (start_time, end_time, monitor_id, status) VALUES ($1, $2, $3, $4)',
          [current, slotEnd, mId, 'available']
        );
        current = slotEnd;
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ message: "Créneaux générés avec succès" });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- GESTION DES BONS CADEAUX ---
app.get('/api/gift-cards', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT gc.*, ft.name as flight_name 
      FROM gift_cards gc 
      JOIN flight_types ft ON gc.flight_type_id = ft.id 
      ORDER BY gc.created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gift-cards', authenticateAdmin, async (req, res) => {
  const { flight_type_id, buyer_name, recipient_name } = req.body;
  const code = "FLUIDE-" + Math.random().toString(36).substring(2, 8).toUpperCase();
  try {
    const result = await pool.query(
      'INSERT INTO gift_cards (code, flight_type_id, buyer_name, recipient_name) VALUES ($1, $2, $3, $4) RETURNING *', 
      [code, flight_type_id, buyer_name, recipient_name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- VÉRIFICATION DES BONS CADEAUX ---
app.get('/api/gift-cards/verify/:code', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT gc.*, ft.name as flight_name, ft.id as flight_type_id 
      FROM gift_cards gc
      JOIN flight_types ft ON gc.flight_type_id = ft.id 
      WHERE gc.code = $1 AND gc.used = false`, 
      [req.params.code]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Code invalide ou déjà utilisé" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Port d'écoute
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Serveur Fluide démarré sur le port ${PORT}`);
});