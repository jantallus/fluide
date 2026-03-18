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
  connectionString: "postgresql://postgres:fuQIzafUNCSMkwiUNeWZKSoMHwfXutDC@yamanote.proxy.rlwy.net:35258/railway",
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = "fluide_secret_key_2026";

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

// --- 1. ROUTES PUBLIQUES & RÉSERVATIONS (UTILISATEURS) ---

app.get('/api/vols', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flight_types ORDER BY price_cents ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/api/slots', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, u.first_name as monitor_name 
      FROM slots s 
      JOIN users u ON s.monitor_id = u.id 
      WHERE s.status = 'available' AND s.start_time > NOW()
      ORDER BY s.start_time ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- 2. GESTION DES BOOKINGS (TABLE BOOKINGS) ---

app.get('/api/bookings', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, ft.name as flight_name, s.start_time, s.end_time, u.first_name as monitor_name
      FROM bookings b
      JOIN slots s ON b.slot_id = s.id
      JOIN flight_types ft ON b.flight_type_id = ft.id
      JOIN users u ON s.monitor_id = u.id
      ORDER BY s.start_time DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings', async (req, res) => {
  const { slotId, flightTypeId, customerName, price } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const booking = await client.query(
      'INSERT INTO bookings (slot_id, flight_type_id, total_price, customer_name, status, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
      [slotId, flightTypeId, price || 0, customerName, 'confirmed']
    );

    await client.query("UPDATE slots SET status = 'booked' WHERE id = $1", [slotId]);

    await client.query('COMMIT');
    res.status(201).json(booking.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/bookings/:id', authenticateAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bookingResult = await client.query('SELECT slot_id FROM bookings WHERE id = $1', [req.params.id]);
    
    if (bookingResult.rows.length > 0) {
      const slotId = bookingResult.rows[0].slot_id;
      await client.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
      await client.query("UPDATE slots SET status = 'available' WHERE id = $1", [slotId]);
    }

    await client.query('COMMIT');
    res.json({ message: "Réservation supprimée et créneau libéré." });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- 3. AUTHENTIFICATION ---

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) return res.status(401).json({ message: "Utilisateur introuvable" });
    
    const user = userResult.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ message: "Mot de passe incorrect" });
    
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '4h' });
    res.json({ token, user: { id: user.id, firstName: user.first_name, role: user.role } });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- 4. ROUTES PLANNING (SLOTS) ---

app.get('/api/appointments', async (req, res) => {
  console.log("--- Tentative de récupération des créneaux ---");
  try {
    const result = await pool.query(`
      SELECT 
        s.id::text as id, 
        s.monitor_id as "resourceId", 
        COALESCE(b.customer_name, s.title, '') as title, 
        date_trunc('minute', s.start_time) as start, 
        date_trunc('minute', s.end_time) as end,
        s.notes,
        s.status,
        EXTRACT(EPOCH FROM (s.end_time - s.start_time))/60 as duration,
        CASE 
          WHEN s.status = 'booked' THEN '#6366f1' 
          WHEN s.status = 'unavailable' THEN '#94a3b8' 
          WHEN (EXTRACT(EPOCH FROM (s.end_time - s.start_time))/60) <= 20 THEN '#f1f5f9' 
          ELSE '#0ea5e9' 
        END as "backgroundColor"
      FROM slots s 
      LEFT JOIN bookings b ON s.id = b.slot_id
      ORDER BY s.start_time ASC
    `);
    console.log(`Succès : ${result.rows.length} créneaux envoyés au calendrier.`);
    res.json(result.rows);
  } catch (err) { 
    console.error("❌ ERREUR CRITIQUE SQL :", err.message);
    res.status(500).json({ error: err.message }); 
  }
});

// ROUTE : GÉNÉRATION DE MASSE
app.post('/api/admin/generate-slots', authenticateAdmin, async (req, res) => {
    const { startDate, endDate, daysToApply } = req.body; 
    console.log(`🚀 Génération sécurisée du ${startDate} au ${endDate}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const definitions = await client.query('SELECT * FROM slot_definitions');
      const monitors = await client.query(`
        SELECT id FROM users 
        WHERE role IN ('monitor', 'admin') 
        AND status = 'Actif'
      `);
      
      let currentDate = new Date(startDate);
      const lastDate = new Date(endDate);
      let count = 0;
  
      while (currentDate <= lastDate) {
        const dayOfWeek = currentDate.getDay(); 
        
        if (daysToApply.map(Number).includes(dayOfWeek)) {
          for (const def of definitions.rows) {
            for (const mon of monitors.rows) {
              const start = new Date(currentDate);
              const [hours, minutes] = def.start_time.split(':');
              
              start.setHours(parseInt(hours), parseInt(minutes), 0, 0);
              
              const end = new Date(start.getTime() + (def.duration_minutes * 60000));
              end.setSeconds(0, 0); 
              end.setMilliseconds(0);

              // Utilisation de ON CONFLICT pour éviter les doublons physiques
              await client.query(`
                INSERT INTO slots (monitor_id, start_time, end_time, status) 
                VALUES ($1, $2, $3, 'available')
                ON CONFLICT (monitor_id, start_time) 
                DO UPDATE SET 
                  end_time = EXCLUDED.end_time,
                  status = CASE 
                    WHEN slots.status = 'booked' THEN 'booked' 
                    ELSE 'available' 
                  END
              `, [mon.id, start, end]);
              
              count++;
            }
          }
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
      await client.query('COMMIT');
      res.json({ message: "Génération terminée sans doublons", count });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error("❌ Erreur génération:", err.message);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});

app.post('/api/appointments', authenticateAdmin, async (req, res) => {
  const { start, end, assignMode, manualMonitorId, title, status, flightTypeId, price } = req.body;
  let monitorId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (assignMode === 'manual' && manualMonitorId) { monitorId = manualMonitorId; } else {
      const monitorsResult = await client.query("SELECT id FROM users WHERE role IN ('monitor', 'admin') AND status = 'Actif'");
      const activeMonitors = monitorsResult.rows.map(m => m.id);
      if (activeMonitors.length === 0) throw new Error("Aucun moniteur actif.");
      monitorId = activeMonitors[Math.floor(Math.random() * activeMonitors.length)];
    }

    const result = await client.query(
      'INSERT INTO slots (monitor_id, start_time, end_time, status, title) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [monitorId, start, end, status || 'available', title]
    );
    const newSlot = result.rows[0];

    if (status === 'booked') {
      await client.query(
        'INSERT INTO bookings (slot_id, flight_type_id, total_price, status, created_at, customer_name) VALUES ($1, $2, $3, $4, NOW(), $5)',
        [newSlot.id, flightTypeId || null, price || 0, 'confirmed', title]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(newSlot);
  } catch (err) { 
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message }); 
  } finally { client.release(); }
});

app.get('/api/appointments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (s.id) -- Empêche de doubler le créneau s'il y a 2 bookings
        s.id::text as id, 
        s.monitor_id as "resourceId", 
        -- SI disponible, on force le titre à vide, PEU IMPORTE la base
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
          WHEN (EXTRACT(EPOCH FROM (s.end_time - s.start_time))/60) <= 20 THEN '#f1f5f9' 
          ELSE '#0ea5e9' 
        END as "backgroundColor"
      FROM slots s 
      LEFT JOIN bookings b ON s.id = b.slot_id
      ORDER BY s.id, b.created_at DESC -- Prend la réservation la plus récente
    `);
    res.json(result.rows);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.delete('/api/admin/appointments/day/:date', authenticateAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM slots WHERE DATE(start_time) = $1 AND status IN ('available', 'unavailable')", [req.params.date]);
    await client.query('COMMIT');
    res.json({ message: "Succès" });
  } catch (err) { 
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message }); 
  } finally { client.release(); }
});

// --- 5. ROUTES MONITEURS (ADMIN) ---

app.get('/api/monitors', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, first_name, email, role, status FROM users 
      WHERE LOWER(role) IN ('admin', 'monitor', 'moniteur') ORDER BY id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/monitors', authenticateAdmin, async (req, res) => {
  const { first_name, email, password, role } = req.body;
  try {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);
    const result = await pool.query(
      'INSERT INTO users (first_name, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, first_name, email, role',
      [first_name, email, hash, role || 'monitor', 'Actif']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ message: "Email déjà utilisé" });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/monitors/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE users SET status = $1 WHERE id = $2", [req.body.status, req.params.id]);
    res.json({ message: "Statut mis à jour" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/monitors/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id = $1 AND role != 'admin'", [req.params.id]);
    res.json({ message: "Succès" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 6. ROUTES GESTION CLIENTS (ADMIN) ---

app.get('/api/admin/clients', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, first_name, email, role FROM users WHERE role = 'user'");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/clients/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id = $1 AND role = 'user'", [req.params.id]);
    res.json({ message: "Succès" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 7. CONFIGURATION & STATS ---

app.get('/api/admin/config/slots-definitions', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM slot_definitions ORDER BY start_time ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/config/slots-definitions', authenticateAdmin, async (req, res) => {
  const { start_time, duration_minutes, label } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO slot_definitions (start_time, duration_minutes, label) VALUES ($1, $2, $3) RETURNING *',
      [start_time, duration_minutes, label]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/config/slots-definitions/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM slot_definitions WHERE id = $1', [req.params.id]);
    res.json({ message: "Supprimé" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/config', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM site_settings');
    const config = result.rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/config/options', authenticateAdmin, async (req, res) => {
  const { option_name, value } = req.body;
  try {
    await pool.query(
      `INSERT INTO site_settings (key, value) VALUES ($1, $2) 
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [option_name, value.toString()]
    );
    res.json({ message: "Configuration mise à jour" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const summary = await pool.query(`SELECT SUM(total_price) as "totalRevenue", COUNT(*) as "totalBookings" FROM bookings WHERE status = 'confirmed'`);
    const upcoming = await pool.query(`
      SELECT b.id, b.total_price, s.start_time, ft.name as flight_name, b.customer_name as client_name, m.first_name as monitor_name
      FROM bookings b JOIN slots s ON b.slot_id = s.id JOIN flight_types ft ON b.flight_type_id = ft.id
      JOIN users m ON s.monitor_id = m.id
      WHERE s.start_time >= NOW() ORDER BY s.start_time ASC
    `);
    const history = await pool.query(`
      SELECT b.id, b.total_price, s.start_time, ft.name as flight_name, b.customer_name as client_name
      FROM bookings b JOIN slots s ON b.slot_id = s.id JOIN flight_types ft ON b.flight_type_id = ft.id
      WHERE s.start_time < NOW() ORDER BY s.start_time DESC LIMIT 10
    `);
    res.json({ summary: summary.rows[0], upcoming: upcoming.rows, history: history.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/vols/:id', authenticateAdmin, async (req, res) => {
  const { price_cents, duration_minutes, allowed_slots } = req.body;
  try {
    await pool.query(
      `UPDATE flight_types SET price_cents = COALESCE($1, price_cents), 
       duration_minutes = COALESCE($2, duration_minutes), allowed_slots = COALESCE($3, allowed_slots) 
       WHERE id = $4`,
      [price_cents, duration_minutes, allowed_slots, req.params.id]
    );
    res.json({ message: "Succès" });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- AJOUT DE LA ROUTE DE MISE À JOUR DES CRÉNEAUX ---
app.put('/api/appointments/:id', async (req, res) => {
    const { id } = req.params;
    const { title, notes, status, monitorId } = req.body;

    try {
        // On cible la table 'slots' (vu dans ton FROM slots s)
        const result = await pool.query(
            `UPDATE slots 
             SET title = $1, 
                 notes = $2, 
                 status = $3, 
                 monitor_id = $4
             WHERE id = $5 
             RETURNING *`,
            [title, notes, status || 'booked', monitorId || null, id]
        );

        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: "Créneau introuvable dans la table slots" });
        }
    } catch (err) {
        console.error("ERREUR SQL :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- 8. BONS CADEAUX ---

app.get('/api/gift-cards', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT gc.*, ft.name as flight_name FROM gift_cards gc JOIN flight_types ft ON gc.flight_type_id = ft.id ORDER BY gc.created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gift-cards', authenticateAdmin, async (req, res) => {
  const { flight_type_id, buyer_name, recipient_name } = req.body;
  const code = "FLUIDE-" + Math.random().toString(36).substring(2, 8).toUpperCase();
  try {
    const result = await pool.query('INSERT INTO gift_cards (code, flight_type_id, buyer_name, recipient_name) VALUES ($1, $2, $3, $4) RETURNING *', [code, flight_type_id, buyer_name, recipient_name]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gift-cards/verify/:code', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT gc.*, ft.name as flight_name, ft.id as flight_type_id FROM gift_cards gc
      JOIN flight_types ft ON gc.flight_type_id = ft.id WHERE gc.code = $1 AND gc.status = 'available'
    `, [req.params.code.toUpperCase()]);
    if (result.rows.length === 0) return res.status(404).json({ message: "Code invalide" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DÉMARRAGE ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => { 
  console.log(`✅ Serveur prêt sur le port ${PORT}`); 
});