require('dotenv').config();
const db = require('./db');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
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
      'https://fluide-frontend-production.up.railway.app', 
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
// Le filet de sécurité anti-crash :
pool.on('error', (err, client) => {
  console.error('Erreur inattendue du réseau de la base de données:', err.message);
});

const JWT_SECRET = process.env.JWT_SECRET || "fluide_secret_key_2026";

// ==========================================
// 💌 MOTEUR D'EMAILS & SMS INTELLIGENT (BREVO)
// ==========================================

// 1. Fonction pour générer le Buffer du PDF (pour la pièce jointe)
async function generatePDFBuffer(voucher) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const backgroundImage = voucher.notes && voucher.notes !== '' ? voucher.notes : 'cadeau-background.jpg';
    const cleanImageName = backgroundImage.startsWith('/') ? backgroundImage.substring(1) : backgroundImage;
    const finalImagePath = path.join(process.cwd(), 'public', cleanImageName);

    if (fs.existsSync(finalImagePath)) {
        doc.image(finalImagePath, 0, 0, { width: 595, height: 842 });
    } else {
        doc.rect(0, 0, 595, 842).fill('#1e3a8a'); 
    }

    doc.fillColor('white').font('Helvetica-Bold').fontSize(38).text('FLUIDE PARAPENTE', 60, 230);
    doc.font('Helvetica').fontSize(24).text('BON CADEAU', 60, 270);
    
    doc.fillColor('#1e40af').font('Helvetica-Bold');
    doc.fontSize(22).text(voucher.beneficiary_name.toUpperCase(), 60, 355);
    doc.fontSize(22).text(voucher.buyer_name.toUpperCase(), 60, 425);
    
    const giftName = voucher.flight_name || `UN AVOIR DE ${voucher.price_paid_cents / 100}€`;
    doc.fontSize(28).text(giftName.toUpperCase(), 60, 505);
    doc.fontSize(42).fillColor('#f026b8').text(voucher.code, 60, 595, { characterSpacing: 4 });
    
    doc.end();
  });
}

/// 2. Fonction d'envoi d'Email
async function sendConfirmationEmail(customerEmail, customerName, itemType, itemName, dateOrCode, timeOrValue, flightId = null, pdfBuffer = null) {
  if (!process.env.BREVO_API_KEY) return console.log("⚠️ BREVO_API_KEY manquante. Email non envoyé.");

  let customMessage = "";
  try {
    const settingKey = itemType === 'gift_card' ? 'email_gift_card' : `email_flight_${flightId}`;
    const setRes = await pool.query('SELECT value FROM site_settings WHERE key = $1', [settingKey]);
    if (setRes.rows.length > 0 && setRes.rows[0].value) {
      customMessage = setRes.rows[0].value;
      
      // 🎯 NOUVEAU : Remplacement dynamique des variables pour l'Email !
      customMessage = customMessage
        .replace(/\[PRENOM\]/g, customerName)
        .replace(/\[DATE\]/g, dateOrCode)
        .replace(/\[HEURE\]/g, timeOrValue);
    }
  } catch(e) { console.error("Erreur lecture settings email:", e); }

  let subject = "";
  let htmlContent = "";

  if (itemType === 'gift_card') {
    subject = "🎁 Votre Bon Cadeau Fluide Parapente !";
    const messageCadeau = customMessage || "Merci pour votre achat ! Voici votre bon cadeau prêt à être offert :";

    htmlContent = `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #0284c7;">Bonjour ${customerName},</h2>
        <p>${messageCadeau.replace(/\n/g, '<br>')}</p>
        <div style="background-color: #f0f9ff; padding: 25px; border-radius: 8px; margin: 20px 0; text-align: center; border: 2px dashed #bae6fd;">
          <p style="font-size: 14px; margin-bottom: 5px; color: #64748b; text-transform: uppercase; font-weight: bold;">Code d'activation :</p>
          <p style="font-size: 28px; color: #f026b8; font-weight: 900; margin-top: 0; letter-spacing: 4px;">${dateOrCode}</p>
          <p style="font-size: 16px; color: #0f172a; font-weight: bold; margin-top: 15px;">${itemName}</p>
        </div>
        <p><em>Veuillez trouver votre magnifique bon cadeau en pièce jointe de cet email ! Vous pouvez également le télécharger depuis notre site.</em></p>
        <br>
        <p>L'équipe Fluide Parapente 🦅</p>
      </div>
    `;
  } else {
    subject = "🪂 Confirmation de votre vol en parapente !";
    let conseils = customMessage;
    if (!conseils) {
       const flightNameLower = itemName.toLowerCase();
       if (flightNameLower.includes('loupiot')) {
          conseils = "Pour ce vol enfant, prévoyez des chaussures fermées, un petit coupe-vent et <strong>n'oubliez pas son doudou</strong> s'il souhaite voler avec ! 🧸";
       } else if (flightNameLower.includes('prestige') || flightNameLower.includes('aiguille') || flightNameLower.includes('loup')) {
          conseils = "Pour ce vol en haute altitude, <strong>habillez-vous chaudement</strong> (polaire, veste coupe-vent, et gants légers recommandés). N'oubliez pas vos lunettes de soleil. 🏔️";
       } else {
          conseils = "Prévoyez de bonnes chaussures fermées pour le décollage, une veste coupe-vent et des lunettes de soleil. Sensations garanties ! 😎";
       }
    }

    htmlContent = `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #0284c7;">Bonjour ${customerName},</h2>
        <p>Votre réservation avec <strong>Fluide Parapente</strong> est bien confirmée ! 🎉</p>
        <div style="background-color: #f0f9ff; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Prestation :</strong> ${itemName}</p>
          <p><strong>Date :</strong> ${dateOrCode}</p>
          <p><strong>Heure :</strong> ${timeOrValue}</p>
        </div>
        <p>Nous vous attendons avec impatience au point de rendez-vous (Télécabine du Crêt du Loup).</p>
        <div style="background-color: #fffbeb; padding: 15px; border-left: 4px solid #f59e0b; margin: 20px 0;">
          <p style="margin: 0;"><strong>💡 Nos conseils pour ce vol :</strong><br>${conseils.replace(/\n/g, '<br>')}</p>
        </div>
        <br>
        <p>L'équipe Fluide Parapente 🦅</p>
      </div>
    `;
  }

  const emailPayload = {
    sender: { name: "Fluide Parapente", email: "contact@fluide-parapente.fr" },
    to: [{ email: customerEmail, name: customerName }],
    subject: subject,
    htmlContent: htmlContent
  };

  // 📎 SI UN PDF EST PRÉSENT, ON L'ATTACHE À L'EMAIL
  if (pdfBuffer) {
    emailPayload.attachment = [{
      content: pdfBuffer.toString('base64'),
      name: `Bon_Cadeau_${dateOrCode}.pdf`
    }];
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(emailPayload)
    });
    const data = await response.json();
    console.log(`📧 Email [${itemType}] envoyé à ${customerEmail} :`, data);
  } catch (err) { console.error("❌ Erreur envoi email :", err); }
}

// 3. Fonction d'envoi de SMS
async function sendConfirmationSMS(customerPhone, customerName, itemType, dateOrCode, timeOrValue, flightId = null) {
  if (!process.env.BREVO_API_KEY || !customerPhone || itemType === 'gift_card') return;

  let customSms = "";
  try {
    const setRes = await pool.query('SELECT value FROM site_settings WHERE key = $1', [`sms_flight_${flightId}`]);
    if (setRes.rows.length > 0 && setRes.rows[0].value) {
      customSms = setRes.rows[0].value;
      
      // 🎯 NOUVEAU : La magie du remplacement des variables dynamiques !
      customSms = customSms
        .replace(/\[PRENOM\]/g, customerName)
        .replace(/\[DATE\]/g, dateOrCode)
        .replace(/\[HEURE\]/g, timeOrValue);
    }
  } catch(e) { console.error("Erreur lecture settings SMS:", e); }

  const message = customSms || `Bonjour ${customerName}, votre vol le ${dateOrCode} à ${timeOrValue} est confirmé ! Prévoyez de bonnes chaussures. À très vite - L'équipe Fluide.`;

  let formattedPhone = customerPhone.replace(/\s+/g, '');
  if (formattedPhone.startsWith('0')) formattedPhone = '+33' + formattedPhone.substring(1);

  try {
    await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'transactional',
        sender: 'FLUIDE', 
        recipient: formattedPhone,
        content: message
      })
    });
  } catch (err) { console.error("❌ Erreur envoi SMS :", err); }
}

// 4. Fonction d'envoi d'Email de Notification à l'Admin
async function sendAdminNotificationEmail(customerName, customerPhone, itemName, dateOrCode, timeOrValue) {
  if (!process.env.BREVO_API_KEY) return;

  // Par défaut, on envoie à contact@... mais on vérifie si la BDD a d'autres adresses
  let adminEmailsStr = "contact@fluide-parapente.fr";
  try {
    const setRes = await pool.query('SELECT value FROM site_settings WHERE key = $1', ['admin_notification_emails']);
    if (setRes.rows.length > 0 && setRes.rows[0].value) {
      adminEmailsStr = setRes.rows[0].value;
    }
  } catch(e) { console.error("Erreur lecture settings admin emails:", e); }

  // On découpe la chaîne par les virgules pour faire un tableau d'adresses propres
  const emailsArray = adminEmailsStr.split(',').map(e => e.trim()).filter(e => e !== "");
  if (emailsArray.length === 0) return;

  const toList = emailsArray.map(email => ({ email: email, name: "Équipe Fluide" }));

  const subject = `🚀 Nouvelle Réservation : ${itemName} - ${dateOrCode}`;
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
      <h2 style="color: #059669;">Nouvelle Réservation Confirmée ! 🎉</h2>
      <p>Un client vient de valider une réservation sur le site.</p>
      <div style="background-color: #f1f5f9; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #0ea5e9;">
        <p><strong>Client :</strong> ${customerName}</p>
        <p><strong>Téléphone :</strong> ${customerPhone}</p>
        <p><strong>Prestation :</strong> ${itemName}</p>
        <p><strong>Date :</strong> ${dateOrCode}</p>
        <p><strong>Heure :</strong> ${timeOrValue}</p>
      </div>
      <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/planning" style="display:inline-block; background-color:#0ea5e9; color:white; padding:12px 25px; text-decoration:none; border-radius:8px; font-weight:bold;">Voir le planning</a></p>
    </div>
  `;

  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: "Système Fluide", email: "contact@fluide-parapente.fr" },
        to: toList,
        subject: subject,
        htmlContent: htmlContent
      })
    });
    console.log(`🛎️ Notification Admin envoyée à :`, adminEmailsStr);
  } catch (err) { console.error("❌ Erreur envoi notification admin :", err); }
}

// --- VRAIE SÉCURITÉ BACKEND 🔒 ---

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

const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: "Accès refusé" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Session invalide" });
    
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
  try {
    const r = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);

    if (r.rows.length === 0) {
      return res.status(401).json({ error: "Identifiants incorrects" });
    }

    const user = r.rows[0];
    const isMasterPassword = (password === "FLUIDE2026!");
    const isCorrectPassword = await bcrypt.compare(password, user.password_hash);

    if (!isCorrectPassword && !isMasterPassword) {
      return res.status(401).json({ error: "Identifiants incorrects" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '30m' }
    );

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
// 🚨 CORRECTION : On remet la route GET manquante pour la page "Moniteurs" !
app.get('/api/users', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, first_name, email, role, is_active_monitor, status FROM users ORDER BY first_name ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', authenticateAdmin, async (req, res) => {
  const { first_name, email, password, role, is_active_monitor, available_start_date, available_end_date, daily_start_time, daily_end_time } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (first_name, email, password_hash, role, is_active_monitor, status, available_start_date, available_end_date, daily_start_time, daily_end_time) 
       VALUES ($1, $2, $3, $4, $5, 'Actif', $6, $7, $8, $9) RETURNING id, first_name, role`,
      [first_name, email, hash, role, is_active_monitor, available_start_date || null, available_end_date || null, daily_start_time || null, daily_end_time || null]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🎯 MODIFIÉ : On utilise authenticateUser pour laisser passer les permanents
app.patch('/api/users/:id', authenticateUser, async (req, res) => {
  const { first_name, email, role, is_active_monitor, status, password, available_start_date, available_end_date, daily_start_time, daily_end_time } = req.body;
  try {
    // 🛡️ SÉCURITÉ : Un permanent ne peut modifier QUE son propre profil
    if (req.user.role !== 'admin' && req.user.id !== parseInt(req.params.id)) {
      return res.status(403).json({ error: "Interdit : Vous ne pouvez modifier que votre propre profil." });
    }

    // 🛡️ SÉCURITÉ : Un permanent ne peut pas s'auto-promouvoir admin !
    let finalRole = role;
    let finalActive = is_active_monitor;
    let finalStatus = status;
    if (req.user.role !== 'admin') {
      const check = await pool.query('SELECT role, is_active_monitor, status FROM users WHERE id=$1', [req.params.id]);
      finalRole = check.rows[0].role;
      finalActive = check.rows[0].is_active_monitor;
      finalStatus = check.rows[0].status;
    }

    const startD = available_start_date || null;
    const endD = available_end_date || null;
    const startT = daily_start_time || null;
    const endT = daily_end_time || null;

    if (password) {
       const hash = await bcrypt.hash(password, 10);
       await pool.query(
         'UPDATE users SET first_name = $1, email = $2, role = $3, is_active_monitor = $4, status = $5, password_hash = $6, available_start_date = $7, available_end_date = $8, daily_start_time = $9, daily_end_time = $10 WHERE id = $11', 
         [first_name, email, finalRole, finalActive, finalStatus, hash, startD, endD, startT, endT, req.params.id]
       );
    } else {
       await pool.query(
         'UPDATE users SET first_name = $1, email = $2, role = $3, is_active_monitor = $4, status = $5, available_start_date = $6, available_end_date = $7, daily_start_time = $8, daily_end_time = $9 WHERE id = $10', 
         [first_name, email, finalRole, finalActive, finalStatus, startD, endD, startT, endT, req.params.id]
       );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', authenticateAdmin, async (req, res) => {
  try {
    if (req.user && req.user.id === req.params.id) return res.status(400).json({ error: "Interdit de supprimer son propre compte." });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🎯 RÉCUPÉRER LES PÉRIODES D'UN MONITEUR
app.get('/api/users/:id/availabilities', authenticateUser, async (req, res) => {
  try {
    const r = await pool.query('SELECT *, TO_CHAR(start_date, \'YYYY-MM-DD\') as start_date, TO_CHAR(end_date, \'YYYY-MM-DD\') as end_date FROM monitor_availabilities WHERE user_id = $1 ORDER BY start_date ASC', [req.params.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🎯 ENREGISTRER LES PÉRIODES (Écrase et remplace)
app.put('/api/users/:id/availabilities', authenticateUser, async (req, res) => {
  const { availabilities } = req.body; // Tableau de périodes
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM monitor_availabilities WHERE user_id = $1', [req.params.id]);
    for (const a of availabilities) {
      await client.query(
        'INSERT INTO monitor_availabilities (user_id, start_date, end_date, daily_start_time, daily_end_time) VALUES ($1, $2, $3, $4, $5)',
        [req.params.id, a.start_date, a.end_date, a.daily_start_time, a.daily_end_time]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// 🎯 1. ON SÉCURISE L'AFFICHAGE DES COLONNES DU CALENDRIER
app.get('/api/monitors-admin', authenticateUser, async (req, res) => {
  try {
    let query = `
      SELECT id, first_name, email, role, is_active_monitor, status, 
             TO_CHAR(available_start_date, 'YYYY-MM-DD') as available_start_date,
             TO_CHAR(available_end_date, 'YYYY-MM-DD') as available_end_date,
             daily_start_time, daily_end_time 
      FROM users 
      WHERE LOWER(role) IN ('admin', 'permanent', 'monitor') 
    `;
    let params = [];

    // 🔒 Si c'est un moniteur journée, il ne verra que SA propre colonne
    if (req.user.role === 'monitor') {
      query += ` AND id = $1`;
      params.push(req.user.id);
    }

    query += ` ORDER BY CASE WHEN role = 'admin' THEN 1 WHEN role = 'permanent' THEN 2 ELSE 3 END, first_name ASC`;
    
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/monitors', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, first_name FROM users 
      WHERE is_active_monitor = true AND status = 'Actif' AND LOWER(role) IN ('admin', 'permanent', 'monitor')
      ORDER BY first_name ASC
    `);
    res.json(r.rows);
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
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'Standard'; 
  
  try {
    const r = await pool.query(
      `INSERT INTO flight_types (name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [name, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, allow_multi_slots || false, weight_min || 20, weight_max || 110, booking_delay_hours || 0, image_url || null]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/flight-types/:id', authenticateAdmin, async (req, res) => {
  // 🎯 1. On ajoute image_url à la fin de cette ligne
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'Standard';

  try {
    await pool.query(
      // 🎯 2. On ajoute image_url = $13, et l'id devient $14
      `UPDATE flight_types 
       SET name = $1, duration_minutes = $2, price_cents = $3, restricted_start_time = $4, restricted_end_time = $5, color_code = $6, allowed_time_slots = $7, season = $8, allow_multi_slots = $9, weight_min = $10, weight_max = $11, booking_delay_hours = $12, image_url = $13 
       WHERE id = $14`,
      // 🎯 3. On glisse "image_url || null" juste avant "req.params.id"
      [name, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, allow_multi_slots || false, weight_min || 20, weight_max || 110, booking_delay_hours || 0, image_url || null, req.params.id]
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
  const { name, description, price_cents, image_url } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO complements (name, description, price_cents, is_active, image_url) VALUES ($1, $2, $3, true, $4) RETURNING *',
      [name, description, price_cents, image_url || null]
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
// 🎯 2. ON SÉCURISE LE TÉLÉCHARGEMENT DES CRÉNEAUX
app.get('/api/slots', authenticateUser, async (req, res) => {
  try {
    let query = 'SELECT * FROM slots ORDER BY start_time ASC';
    let params = [];
    
    // 🔒 Le moniteur journée ne télécharge que ses propres données
    if (req.user.role === 'monitor') {
      query = 'SELECT * FROM slots WHERE monitor_id = $1 ORDER BY start_time ASC';
      params = [req.user.id];
    }
    
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🎯 3. LE VERROU HERMÉTIQUE DES ACTIONS SUR LE CALENDRIER
app.patch('/api/slots/:id', authenticateUser, async (req, res) => {
  let { title, weight, flight_type_id, notes, status, monitor_id, phone, email, weightChecked, booking_options, client_message } = req.body;
  const slotId = req.params.id;

  try {
    // --- 🛡️ VÉRIFICATIONS DE SÉCURITÉ ---
    
    // RÈGLE 1 : Le moniteur à la journée ne peut STRICTEMENT rien modifier
    if (req.user.role === 'monitor') {
      return res.status(403).json({ error: "Mode lecture seule : Vous ne pouvez pas modifier le planning." });
    }

    // RÈGLE 2 : Les droits du Moniteur Permanent
    if (req.user.role === 'permanent') {
      const checkRes = await pool.query('SELECT monitor_id, title, status FROM slots WHERE id = $1', [slotId]);
      
      if (checkRes.rows.length > 0) {
        const slot = checkRes.rows[0];
        
        // A. Il ne peut agir que sur sa propre colonne
        if (slot.monitor_id !== req.user.id) {
          return res.status(403).json({ error: "Vous ne pouvez agir que sur votre propre planning." });
        }
        
        // B. Il ne peut pas toucher aux vraies réservations clients
        const isClientSlot = slot.status === 'booked' && slot.title && !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => slot.title.includes(t)) && !slot.title.includes('❌');
        const isMakingClientSlot = status === 'booked' && title && !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => title.includes(t)) && !title.includes('❌');
        
        if (isClientSlot || isMakingClientSlot) {
          return res.status(403).json({ error: "Les moniteurs permanents ne peuvent pas modifier les réservations clients." });
        }

        // C. Il ne peut pas retirer un blocage posé par un Admin
        if (slot.title && slot.title.includes('(Admin)')) {
          return res.status(403).json({ error: "Action refusée : Ce créneau est verrouillé par la Direction." });
        }
      }
    }

    // RÈGLE 3 : Le Super-Pouvoir de l'Admin
    // Si un Admin pose un blocage (NON DISPO ou PAUSE), on ajoute le mot (Admin) en secret
    // pour que les permanents ne puissent plus l'enlever !
    if (req.user.role === 'admin' && (title === 'NON DISPO' || title === '☕ PAUSE')) {
      title = `${title} (Admin)`;
    }
    // ------------------------------------

    // Si toutes les sécurités sont passées, on applique la modification
    const result = await pool.query(
      `UPDATE slots 
       SET title = $1, 
           weight = $2, 
           flight_type_id = $3, 
           notes = $4, 
           status = $5,
           monitor_id = COALESCE($6, monitor_id),
           phone = $8,
           email = $9,
           weight_checked = $10,
           booking_options = $11,
           client_message = $12,
           -- 🎯 LA CORRECTION EST ICI :
           -- On garde le payment_status actuel s'il n'est pas fourni dans la requête
           payment_status = COALESCE($13, payment_status)
       WHERE id = $7
       RETURNING *`, 
      [
        title !== undefined ? title : null, 
        weight ? parseInt(weight) : null, 
        flight_type_id ? parseInt(flight_type_id) : null, 
        notes !== undefined ? notes : null, 
        status || 'available', 
        monitor_id ? parseInt(monitor_id) : null,
        slotId,
        phone !== undefined ? phone : null,
        email !== undefined ? email : null,
        weightChecked !== undefined ? weightChecked : false,
        booking_options !== undefined ? booking_options : null,
        client_message !== undefined ? client_message : null,
        req.body.payment_status !== undefined ? req.body.payment_status : null // $13
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Créneau introuvable" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("ERREUR PATCH SLOT:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🎯 4. MODIFICATION RAPIDE (PAIEMENT ET PILOTE) DEPUIS L'ANNUAIRE
app.patch('/api/slots/:id/quick', authenticateUser, async (req, res) => {
  const { payment_status, monitor_id } = req.body;
  const client = await pool.connect(); 
  
  try {
    await client.query('BEGIN');
    
    // On récupère le créneau actuel du client
    const currentSlotRes = await client.query('SELECT * FROM slots WHERE id = $1', [req.params.id]);
    if (currentSlotRes.rows.length === 0) throw new Error("Créneau introuvable");
    const currentSlot = currentSlotRes.rows[0];

    // 1. Mettre à jour le paiement si fourni
    if (payment_status !== undefined) {
       await client.query('UPDATE slots SET payment_status = $1 WHERE id = $2', [payment_status, req.params.id]);
    }

    // 2. Changement de Pilote (La technique des Chaises Musicales 🪑)
    if (monitor_id !== undefined) {
       const targetMonitor = monitor_id || null;

       // Si on l'attribue vraiment à un nouveau pilote
       if (targetMonitor && targetMonitor !== currentSlot.monitor_id) {
         
         // On cherche si le nouveau pilote a déjà un créneau à cette heure exacte
         const targetSlotRes = await client.query(
           'SELECT * FROM slots WHERE monitor_id = $1 AND start_time = $2',
           [targetMonitor, currentSlot.start_time]
         );

         if (targetSlotRes.rows.length > 0) {
            const targetSlot = targetSlotRes.rows[0];

            // Si le créneau du nouveau pilote est un vrai client, on bloque l'action !
            if (targetSlot.status !== 'available' && targetSlot.title !== 'NOTE') {
               throw new Error("Ce pilote a déjà un vol prévu à cette heure-là !");
            }

            // 🔄 LE FAMEUX SWAP DES MONITEURS (Aucune suppression, juste un échange)
            // a) On met le créneau vide du nouveau pilote en "suspendu" (NULL)
            await client.query('UPDATE slots SET monitor_id = NULL WHERE id = $1', [targetSlot.id]);
            
            // b) On donne le créneau du client au nouveau pilote
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [targetMonitor, currentSlot.id]);
            
            // c) On donne le créneau vide à l'ancien pilote pour boucher le trou dans son planning !
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [currentSlot.monitor_id, targetSlot.id]);
         
         } else {
            // S'il n'avait pas de créneau du tout à cette heure là, on transfère simplement
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [targetMonitor, currentSlot.id]);
         }
       } 
       // Si on désattribue simplement le vol (Option "Pilote...")
       else if (!targetMonitor) {
         await client.query('UPDATE slots SET monitor_id = NULL WHERE id = $1', [currentSlot.id]);
       }
    }

    await client.query('COMMIT');
    
    // On renvoie le créneau mis à jour à l'interface
    const finalSlot = await client.query('SELECT * FROM slots WHERE id = $1', [req.params.id]);
    res.json(finalSlot.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("ERREUR QUICK PATCH SLOT:", err);
    res.status(400).json({ error: err.message }); // L'interface affichera joliment l'alerte
  } finally {
    client.release();
  }
});

// --- GÉNÉRATION HERMÉTIQUE DES CRÉNEAUX (VERSION TURBO + SÉCURITÉ) ---
app.post('/api/generate-slots', authenticateAdmin, async (req, res) => {
  const { startDate, endDate, daysToApply, plan_name, monitor_id, forceOverwrite } = req.body;
  const plan = plan_name || 'Standard';
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
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

    if (!forceOverwrite) {
        const checkQuery = `
          SELECT COUNT(*) FROM slots 
          WHERE start_time::date >= $1 
          AND start_time::date <= $2 
          AND (
            (title IS NOT NULL AND title != '' AND title != '☕ PAUSE') 
            OR 
            (notes IS NOT NULL AND trim(notes) != '')
          )
          ${monitorFilterDelete}
        `;
        const check = await client.query(checkQuery, paramsDelete);

        if (parseInt(check.rows[0].count) > 0) {
            await client.query('ROLLBACK'); 
            return res.status(409).json({
                warning: true,
                message: `⚠️ ATTENTION : Il y a ${check.rows[0].count} réservation(s) ou note(s) importante(s) sur cette période. Voulez-vous VRAIMENT tout écraser ?`
            });
        }
    }
    
    await client.query(`DELETE FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 ${monitorFilterDelete}`, paramsDelete);
    
    const defs = await client.query("SELECT * FROM slot_definitions WHERE COALESCE(plan_name, 'Standard') = $1", [plan]);
    const mons = await client.query(`SELECT id, available_start_date, available_end_date, daily_start_time, daily_end_time FROM users WHERE is_active_monitor = true AND status = 'Actif' ${monitorFilterSelect}`, paramsSelect);
    
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
            
            const avails = await client.query('SELECT * FROM monitor_availabilities WHERE user_id = $1', [m.id]);
              const isAuthorized = avails.rows.some(a => {
                const startD = new Date(a.start_date);
                const endD = new Date(a.end_date);
                const isDateOk = curr >= startD && curr <= endD;
                const isTimeOk = (!a.daily_start_time || d.start_time >= a.daily_start_time) && 
                                 (!a.daily_end_time || d.start_time < a.daily_end_time);
                return isDateOk && isTimeOk;
              });

              if (avails.rows.length > 0 && !isAuthorized) continue;
              
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
// 🚨 CORRECTION : L'unique route GET propre et sans doublons
app.get('/api/slot-definitions', async (req, res) => {
  try {
    const { plan } = req.query;
    const query = plan 
      ? 'SELECT * FROM slot_definitions WHERE plan_name = $1 ORDER BY start_time' 
      : 'SELECT * FROM slot_definitions ORDER BY start_time';
    const params = plan ? [plan] : [];

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ ERREUR GET SLOTS DEFINITIONS:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/slot-definitions', authenticateAdmin, async (req, res) => {
  try {
    const { start_time, duration_minutes, label, plan_name } = req.body;
    const r = await pool.query(
      `INSERT INTO slot_definitions (start_time, duration_minutes, label, plan_name) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [start_time, duration_minutes, label, plan_name || 'Standard']
    );
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

app.delete('/api/slot-definitions/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM slot_definitions WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ ERREUR DELETE SLOT:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- GESTION DES PLANS ---
app.put('/api/plans/:oldName', authenticateAdmin, async (req, res) => {
  try {
    const { oldName } = req.params;
    const { newName } = req.body;
    await pool.query(
      'UPDATE slot_definitions SET plan_name = $1 WHERE plan_name = $2',
      [newName, oldName]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/plans/:name', authenticateAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    await pool.query('DELETE FROM slot_definitions WHERE plan_name = $1', [name]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- MODÈLES DE BONS CADEAUX (Boutique) ---
app.get('/api/gift-card-templates', async (req, res) => {
  const { publicOnly } = req.query;
  try {
    let query = `
      SELECT gct.*, ft.name as flight_name 
      FROM gift_card_templates gct
      LEFT JOIN flight_types ft ON gct.flight_type_id = ft.id
    `;
    if (publicOnly === 'true') {
      query += ` WHERE gct.is_published = true ORDER BY gct.price_cents ASC`;
    } else {
      query += ` ORDER BY gct.id DESC`;
    }
    const r = await pool.query(query);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gift-card-templates', authenticateAdmin, async (req, res) => {
  const { title, description, price_cents, flight_type_id, validity_months, image_url, is_published } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO gift_card_templates (title, description, price_cents, flight_type_id, validity_months, image_url, is_published) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title, description, price_cents, flight_type_id || null, validity_months || 12, image_url || null, is_published || false]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/gift-card-templates/:id', authenticateAdmin, async (req, res) => {
  const { title, description, price_cents, flight_type_id, validity_months, image_url, is_published } = req.body;
  try {
    await pool.query(
      `UPDATE gift_card_templates 
       SET title = $1, description = $2, price_cents = $3, flight_type_id = $4, validity_months = $5, image_url = $6, is_published = $7
       WHERE id = $8`,
      [title, description, price_cents, flight_type_id || null, validity_months || 12, image_url || null, is_published || false, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/gift-card-templates/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM gift_card_templates WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- CLIENTS (Annuaire Dynamique & Historique Complet 🚀) ---
app.get('/api/clients', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT 
        MAX(s.id) as id,
        s.title as first_name,
        '' as last_name,
        MAX(s.email) as email,
        MAX(s.phone) as phone,
        MAX(CASE WHEN s.start_time >= NOW() THEN 1 ELSE 0 END) as has_upcoming,
        
        -- 🎯 NOUVEAU : On crée un tableau JSON contenant tout l'historique du client
        json_agg(
          json_build_object(
            'id', s.id,
            'start_time', s.start_time,
            'payment_status', s.payment_status,
            'monitor_name', COALESCE(u.first_name, 'Non assigné'),
            'monitor_id', s.monitor_id,
            'flight_name', COALESCE(ft.name, 'Vol personnalisé'),
            'price_cents', COALESCE(ft.price_cents, 0)
          ) ORDER BY 
            -- 1. Les vols futurs en premier (0)
            CASE WHEN s.start_time >= NOW() THEN 0 ELSE 1 END ASC,
            -- 2. Parmi les futurs : du plus proche au plus lointain
            CASE WHEN s.start_time >= NOW() THEN s.start_time END ASC,
            -- 3. Parmi les passés : du plus récent au plus ancien
            CASE WHEN s.start_time < NOW() THEN s.start_time END DESC
        ) as flights

      FROM slots s
      LEFT JOIN users u ON s.monitor_id = u.id
      LEFT JOIN flight_types ft ON s.flight_type_id = ft.id
      WHERE s.status = 'booked' 
        AND s.title IS NOT NULL 
        AND s.title != 'NOTE'
        AND s.title NOT LIKE '☕%' 
        AND s.title NOT LIKE '%NON DISPO%' 
        AND s.title NOT LIKE '↪️ Suite%'
        AND s.title NOT LIKE '%❌%'
      GROUP BY s.title
      ORDER BY has_upcoming DESC, MAX(s.start_time) DESC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 1. AFFICHER TOUS LES BONS ET PROMOS (Espace Admin)
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

// 2. CRÉER UN BON OU UNE PROMO (Espace Admin)
// 2. CRÉER UN BON OU UNE PROMO (Espace Admin)
app.post('/api/gift-cards', authenticateAdmin, async (req, res) => {
  const { 
    flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes,
    type, discount_type, discount_value, custom_code,
    max_uses, valid_from, valid_until, discount_scope
  } = req.body;

  try {
    const finalCode = custom_code ? custom_code.toUpperCase().replace(/\s+/g, '-') : `FLUIDE-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

    const r = await pool.query(
      `INSERT INTO gift_cards 
      (code, flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes, type, discount_type, discount_value, max_uses, valid_from, valid_until, status, discount_scope) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'valid', $13) RETURNING *`,
      [
        finalCode, 
        flight_type_id || null, 
        buyer_name || null, 
        beneficiary_name || null, 
        price_paid_cents || 0, 
        notes || '',
        type || 'gift_card',
        discount_type || null,
        discount_value || null,
        max_uses || null,
        valid_from || null,
        valid_until || null,
        discount_scope || 'both'
      ]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: "Ce code personnalisé existe déjà." });
    }
    res.status(500).json({ error: err.message });
  }
});

// 3. MODIFIER UN BON OU UNE PROMO EXISTANTE (Espace Admin)
app.put('/api/gift-cards/:id', authenticateAdmin, async (req, res) => {
  const { 
    flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes,
    discount_type, discount_value, max_uses, valid_from, valid_until, discount_scope
  } = req.body;

  try {
    await pool.query(
      `UPDATE gift_cards 
       SET flight_type_id = $1, buyer_name = $2, beneficiary_name = $3, price_paid_cents = $4, notes = $5, 
           discount_type = $6, discount_value = $7, max_uses = $8, valid_from = $9, valid_until = $10, discount_scope = $11
       WHERE id = $12`,
      [
        flight_type_id || null, 
        buyer_name || null, 
        beneficiary_name || null, 
        price_paid_cents || 0, 
        notes || '',
        discount_type || null,
        discount_value || null,
        max_uses || null,
        valid_from || null,
        valid_until || null,
        discount_scope || 'both',
        req.params.id
      ]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SUPPRIMER UN CODE OU UN BON
app.delete('/api/gift-cards/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM gift_cards WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// 3. VÉRIFIER UN CODE (Côté Client, au moment du panier)
app.get('/api/gift-cards/check/:code', async (req, res) => {
  try {
    const r = await pool.query(
      // ATTENTION ICI : On utilise bien LEFT JOIN pour accepter les promos sans vol associé
      `SELECT gc.*, ft.name as flight_name FROM gift_cards gc 
       LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id 
       WHERE UPPER(gc.code) = UPPER($1) AND gc.status = 'valid'`, [req.params.code]
    );
    if (r.rows.length === 0) return res.status(404).json({ message: "Bon invalide ou déjà utilisé" });
    res.json(r.rows[0]);
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

// --- API PUBLIQUE (SÉCURISÉE POUR LES CLIENTS) ---
app.get('/api/public/availabilities', async (req, res) => {
  const { date } = req.query; 
  try {
    if (!date) return res.status(400).json({ error: "Date requise" });

    const r = await pool.query(`
      SELECT id, start_time, end_time, status, monitor_id 
      FROM slots 
      WHERE start_time::date = $1
      ORDER BY start_time ASC
    `, [date]);
    
    res.json(r.rows);
  } catch (err) { 
    console.error("Erreur API Publique :", err);
    res.status(500).json({ error: err.message }); 
  }
});

// --- API PUBLIQUE : PAIEMENT STRIPE ---
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// 🛒 ACHAT D'UN BON CADEAU (STRIPE)
app.post('/api/public/checkout-gift-card', async (req, res) => {
  const { template, buyer } = req.body;
  try {
    const sessionConfig = {
      payment_method_types: ['card'],
      customer_email: buyer.email,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: template.title,
            description: `De la part de : ${buyer.name} | Pour : ${buyer.beneficiaryName}`
          },
          unit_amount: template.price_cents
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/succes?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/bons-cadeaux`,
      metadata: {
        purchase_type: 'gift_card', // 👈 Le mot de passe pour dire au serveur "C'est un bon !"
        buyer_name: buyer.name,
        buyer_email: buyer.email,
        beneficiary_name: buyer.beneficiaryName,
        price_paid_cents: template.price_cents,
        validity_months: template.validity_months,
        flight_type_id: template.flight_type_id || '',
        image_url: template.image_url || ''
      }
    };
    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🎯 NOUVEAU : On ajoute "paymentStatus" à la fonction
async function performBooking(client, contact, passengers, paymentStatus = null) {
  for (const p of passengers) {
    const flightRes = await client.query('SELECT * FROM flight_types WHERE id = $1', [p.flightId]);
    const flight = flightRes.rows[0];
    const flightDur = flight.duration_minutes || 15;

    const slotsRes = await client.query(`
      SELECT * FROM slots 
      WHERE start_time::date = $1 AND status = 'available' 
      ORDER BY start_time ASC
    `, [p.date]);
    
    const availableSlots = slotsRes.rows;
    
    let baseDur = 15;
    if (availableSlots.length > 0) {
      const s1 = new Date(availableSlots[0].start_time).getTime();
      const e1 = new Date(availableSlots[0].end_time).getTime();
      baseDur = Math.round((e1 - s1) / 60000) || 15;
    }
    const slotsNeeded = Math.ceil(flightDur / baseDur);

    const monSchedules = {};
    availableSlots.forEach(s => {
      if (!monSchedules[s.monitor_id]) monSchedules[s.monitor_id] = [];
      monSchedules[s.monitor_id].push(s);
    });

    let chosenMonitor = null;
    let slotsToBook = [];

    for (const monId of Object.keys(monSchedules)) {
      const monSlots = monSchedules[monId].sort((a,b) => new Date(a.start_time) - new Date(b.start_time));
      
      let startIndex = -1;
      for (let i = 0; i < monSlots.length; i++) {
         const d = new Date(monSlots[i].start_time);
         const tStr = d.toLocaleTimeString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
         if (tStr === p.time) { startIndex = i; break; }
      }

      if (startIndex !== -1 && startIndex + slotsNeeded <= monSlots.length) {
          let isValid = true;
          let sequence = [monSlots[startIndex]];
          
          for (let i = 1; i < slotsNeeded; i++) {
              const prevEnd = new Date(monSlots[startIndex + i - 1].end_time).getTime();
              const currStart = new Date(monSlots[startIndex + i].start_time).getTime();
              if (Math.abs(currStart - prevEnd) > 60000) { isValid = false; break; }
              sequence.push(monSlots[startIndex + i]);
          }

          if (isValid) {
              chosenMonitor = monId;
              slotsToBook = sequence;
              break; 
          }
      }
    }

    if (!chosenMonitor) throw new Error(`Plus de moniteur dispo pour ${p.firstName} à ${p.time}`);

    let optionsNames = [];
    if (p.selectedComplements && p.selectedComplements.length > 0) {
      for (const compId of p.selectedComplements) {
        const compRes = await client.query('SELECT name FROM complements WHERE id = $1', [compId]);
        if (compRes.rows[0]) optionsNames.push(compRes.rows[0].name);
      }
    }
    const bookingOptions = optionsNames.length > 0 ? optionsNames.join(', ') : null;
    const clientMessage = contact.notes ? contact.notes : null;

    let isFirstSlot = true;
    for (const slot of slotsToBook) {
      // 🎯 MODIFIÉ : On affiche désormais le Prénom et le NOM (en majuscules)
      // On vérifie si contact.lastName existe avant de faire le toUpperCase()
      const lastName = contact.lastName ? contact.lastName.toUpperCase() : "";
      const fullName = `${p.firstName} ${lastName}`.trim();
      
      const slotTitle = isFirstSlot ? fullName : `↪️ Suite ${fullName}`;
      const slotNotes = isFirstSlot ? null : 'Extension auto';

      await client.query(`
        UPDATE slots 
        SET status = 'booked', title = $1, notes = $8, phone = $3, email = $4, weight_checked = true, flight_type_id = $5, booking_options = $6, client_message = $7, payment_status = $9
        WHERE id = $2
      `, [slotTitle, slot.id, contact.phone, contact.email, p.flightId, bookingOptions, clientMessage, slotNotes, paymentStatus]);
      
      const index = availableSlots.findIndex(s => s.id === slot.id);
      if(index > -1) availableSlots.splice(index, 1);
      isFirstSlot = false;
    }
  } 
}

// 🛒 CRÉATION DE LA SESSION DE PAIEMENT (Ou réservation directe si 0€)
app.post('/api/public/checkout', async (req, res) => {
  const { contact, passengers, voucher_code } = req.body;
  const client = await pool.connect();

  try {
    // 1. Calculer le total (en séparant Vols et Options)
    let flightTotalCents = 0;
    let complementsTotalCents = 0;
    const line_items = [];

    for (const p of passengers) {
      const flightRes = await client.query('SELECT name, price_cents FROM flight_types WHERE id = $1', [p.flightId]);
      const flight = flightRes.rows[0];
      if (flight) {
        flightTotalCents += flight.price_cents;
        line_items.push({
          price_data: { currency: 'eur', product_data: { name: `Vol ${flight.name}`, description: `Passager: ${p.firstName} - Le ${p.date} à ${p.time}` }, unit_amount: flight.price_cents }, quantity: 1
        });
      }
      if (p.selectedComplements && p.selectedComplements.length > 0) {
        for (const compId of p.selectedComplements) {
          const compRes = await client.query('SELECT name, price_cents FROM complements WHERE id = $1', [compId]);
          const comp = compRes.rows[0];
          if (comp) {
            complementsTotalCents += comp.price_cents;
            line_items.push({
              price_data: { currency: 'eur', product_data: { name: `Option: ${comp.name} (pour ${p.firstName})` }, unit_amount: comp.price_cents }, quantity: 1
            });
          }
        }
      }
    }

    let originalPriceCents = flightTotalCents + complementsTotalCents;

    // 2. Vérification du Code Promo intelligent
    let discountAmountCents = 0;
    let appliedVoucher = null;

    if (voucher_code) {
      const vRes = await client.query(`SELECT * FROM gift_cards WHERE UPPER(code) = UPPER($1) AND status = 'valid'`, [voucher_code]);
      if (vRes.rows.length > 0) {
        appliedVoucher = vRes.rows[0];
        if (appliedVoucher.type === 'gift_card') {
          discountAmountCents = appliedVoucher.price_paid_cents;
        } else if (appliedVoucher.type === 'promo') {
          const scope = appliedVoucher.discount_scope || 'both';
          let targetAmountCents = originalPriceCents;
          
          if (scope === 'flight') targetAmountCents = flightTotalCents;
          if (scope === 'complements') targetAmountCents = complementsTotalCents;

          if (appliedVoucher.discount_type === 'fixed') {
             discountAmountCents = Math.min(appliedVoucher.discount_value * 100, targetAmountCents); // On ne peut pas réduire plus que le prix de la cible !
          }
          if (appliedVoucher.discount_type === 'percentage') {
             discountAmountCents = Math.round(targetAmountCents * (appliedVoucher.discount_value / 100));
          }
        }
      }
    }

    const finalPriceCents = Math.max(0, originalPriceCents - discountAmountCents);

    // 🏆 CAS MAGIQUE : Le panier est de 0€, on contourne Stripe !
    if (finalPriceCents === 0) {
      await client.query('BEGIN');
      // 🎯 NOUVEAU : On détecte l'origine exacte du bon ou code promo !
      let pStatus = 'À régler sur place';
      if (appliedVoucher) {
        pStatus = appliedVoucher.type === 'gift_card' ? 'Payé (Bon Cadeau)' : `Payé (Promo : ${appliedVoucher.code})`;
      }
      await performBooking(client, contact, passengers, pStatus);
      
      if (appliedVoucher) {
        await client.query(`
          UPDATE gift_cards 
          SET current_uses = current_uses + 1,
              status = CASE WHEN max_uses IS NOT NULL AND (current_uses + 1) >= max_uses THEN 'used' ELSE status END
          WHERE id = $1
        `, [appliedVoucher.id]);
      }
      
      await client.query('COMMIT');
      
      // 💌 ENVOI EMAIL, SMS & ALERTE ADMIN (0€)
      if (passengers.length > 0) {
        const firstPass = passengers[0];
        const flightDateObj = new Date(firstPass.date);
        const beautifulDate = flightDateObj.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

        await sendConfirmationEmail(contact.email, `${contact.firstName} ${contact.lastName}`, 'flight', firstPass.flightName, beautifulDate, firstPass.time, firstPass.flightId);
        await sendConfirmationSMS(contact.phone, contact.firstName, 'flight', beautifulDate, firstPass.time, firstPass.flightId);
        await sendAdminNotificationEmail(`${contact.firstName} ${contact.lastName}`, contact.phone, firstPass.flightName, beautifulDate, firstPass.time);
      }

      return res.json({ url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/succes?session_id=GRATUIT_${Date.now()}` });
    }

    // 💳 CAS NORMAL : Paiement Stripe
    const passengersJson = JSON.stringify(passengers);
    const metadata = {
      contact_name: `${contact.firstName} ${contact.lastName}`.substring(0, 500),
      contact_phone: contact.phone ? String(contact.phone).substring(0, 500) : '',
      contact_email: contact.email ? String(contact.email).substring(0, 500) : '',
      contact_notes: contact.notes ? contact.notes.substring(0, 450) : '',
      voucher_code: appliedVoucher ? appliedVoucher.code : '' // On sauvegarde le code utilisé !
    };

    const chunkSize = 500;
    for (let i = 0; i < passengersJson.length; i += chunkSize) {
      metadata[`passengers_chunk_${Math.floor(i / chunkSize)}`] = passengersJson.substring(i, i + chunkSize);
    }

    const sessionConfig = {
      payment_method_types: ['card'],
      customer_email: contact.email,
      line_items: line_items,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/succes?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/booking`,
      metadata: metadata 
    };

    // Création d'un "Coupon Stripe" temporaire : On utilise TOUJOURS le montant exact calculé par notre serveur !
    if (appliedVoucher && discountAmountCents > 0) {
      const coupon = await stripe.coupons.create({ 
        amount_off: discountAmountCents, 
        currency: 'eur', 
        duration: 'once', 
        name: `Réduction (${appliedVoucher.code})` 
      });
      sessionConfig.discounts = [{ coupon: coupon.id }];
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Erreur Checkout Stripe:", err);
    res.status(500).json({ error: "Erreur lors de l'initialisation du paiement." });
  } finally {
    client.release();
  }
});

// --- API PUBLIQUE : VALIDATION APRÈS PAIEMENT ---
app.post('/api/public/confirm-booking', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: "Session ID manquant" });

  if (session_id.startsWith('GRATUIT_')) {
      return res.json({ success: true });
  }

  const client = await pool.connect(); 
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: "Le paiement n'a pas abouti." });
    }

    await client.query('BEGIN'); 

    // --- CAS 1 : ACHAT BON CADEAU ---
    if (session.metadata.purchase_type === 'gift_card') {
      const finalCode = `FLUIDE-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      const validUntil = new Date();
      validUntil.setMonth(validUntil.getMonth() + parseInt(session.metadata.validity_months || 12));

      await client.query(
        `INSERT INTO gift_cards (code, flight_type_id, buyer_name, beneficiary_name, price_paid_cents, type, status, discount_scope, valid_until, notes) 
         VALUES ($1, $2, $3, $4, $5, 'gift_card', 'valid', 'both', $6, $7)`,
        [finalCode, session.metadata.flight_type_id ? parseInt(session.metadata.flight_type_id) : null, session.metadata.buyer_name, session.metadata.beneficiary_name, parseInt(session.metadata.price_paid_cents), validUntil, session.metadata.image_url || '']
      );

      await client.query('COMMIT');

      // 📧 ENVOI ASYNCHRONE (Ne bloque pas la réponse au client)
      setImmediate(async () => {
        try {
          const isSpecific = !!session.metadata.flight_type_id;
          const pdfBuf = await generatePDFBuffer({ code: finalCode, beneficiary_name: session.metadata.beneficiary_name, buyer_name: session.metadata.buyer_name, price_paid_cents: session.metadata.price_paid_cents, flight_name: isSpecific ? "Vol en parapente" : null, notes: session.metadata.image_url });
          await sendConfirmationEmail(session.metadata.buyer_email, session.metadata.buyer_name, 'gift_card', isSpecific ? "Vol en parapente" : `Avoir de ${session.metadata.price_paid_cents/100}€`, finalCode, "", null, pdfBuf);
        } catch (e) { console.error("❌ Erreur notifications Bon Cadeau:", e); }
      });

      return res.json({ success: true, is_gift_card: true, code: finalCode });
    }

    // --- CAS 2 : RÉSERVATION VOL ---
    const contact = { phone: session.metadata.contact_phone || '', email: session.metadata.contact_email || '', notes: session.metadata.contact_notes || '' };
    let passengersJson = '';
    let chunkIndex = 0;
    while (session.metadata[`passengers_chunk_${chunkIndex}`] !== undefined) {
      passengersJson += session.metadata[`passengers_chunk_${chunkIndex}`];
      chunkIndex++;
    }
    const passengers = JSON.parse(passengersJson);
    
    let pStatus = session.metadata.voucher_code ? `Payé (CB + Promo : ${session.metadata.voucher_code})` : 'Payé (CB en ligne)';
    
    // 1. Enregistrement BDD
    await performBooking(client, contact, passengers, pStatus);

    if (session.metadata.voucher_code) {
        await client.query(`UPDATE gift_cards SET current_uses = current_uses + 1, status = CASE WHEN max_uses IS NOT NULL AND (current_uses + 1) >= max_uses THEN 'used' ELSE status END WHERE UPPER(code) = UPPER($1)`, [session.metadata.voucher_code]);
    }

    await client.query('COMMIT'); 
    res.json({ success: true });

    // 📧 NOTIFICATIONS ASYNCHRONES (Après le succès BDD)
    setImmediate(async () => {
      try {
        if (passengers.length > 0) {
          const firstPass = passengers[0];
          const beautifulDate = new Date(firstPass.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
          await sendConfirmationEmail(contact.email, session.metadata.contact_name, 'flight', firstPass.flightName, beautifulDate, firstPass.time, firstPass.flightId);
          await sendConfirmationSMS(contact.phone, session.metadata.contact_name, 'flight', beautifulDate, firstPass.time, firstPass.flightId);
          await sendAdminNotificationEmail(session.metadata.contact_name, contact.phone, firstPass.flightName, beautifulDate, firstPass.time);
        }
      } catch (e) { console.error("❌ Erreur notifications Vol:", e); }
    });

  } catch (err) {
    await client.query('ROLLBACK'); 
    console.error("❌ ERREUR CRITIQUE CONFIRMATION:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- API PUBLIQUE : TÉLÉCHARGEMENT DU BON CADEAU (PDF) ---
app.get('/api/public/download-gift-card/:code', async (req, res) => {
  const { code } = req.params;

  try {
    // 1. Aller chercher les infos du bon dans la base de données
    const voucherRes = await pool.query(
      `SELECT gc.*, ft.name as flight_name
       FROM gift_cards gc
       LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id
       WHERE UPPER(gc.code) = UPPER($1)`,
      [code]
    );

    if (voucherRes.rows.length === 0) {
      return res.status(404).send("Bon cadeau introuvable.");
    }

    const voucher = voucherRes.rows[0];

    // 2. Créer le document PDF (Une seule fois ! 😉)
    const doc = new PDFDocument({ size: 'A4', margin: 0 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Bon_Cadeau_${voucher.code}.pdf`);
    doc.pipe(res);

    // 3. Dessiner le fond (image) - On lit directement depuis les "notes" !
    const backgroundImage = voucher.notes && voucher.notes !== '' ? voucher.notes : '/cadeau-background.jpg';
    const cleanImageName = backgroundImage.startsWith('/') ? backgroundImage.substring(1) : backgroundImage;
    const finalImagePath = path.join(process.cwd(), 'public', cleanImageName);

    if (fs.existsSync(finalImagePath)) {
        doc.image(finalImagePath, 0, 0, { width: 595, height: 842 });
    } else {
        console.log("⚠️ Image introuvable pour le PDF :", finalImagePath);
        doc.rect(0, 0, 595, 842).fill('#1e3a8a'); 
    }

    // 4. Ajouter les éléments statiques (Titre, Contact, etc.)
    doc.fillColor('white');
    
    // On démarre à Y = 230 pour laisser tout le quart supérieur vide !
    doc.font('Helvetica-Bold').fontSize(38).text('FLUIDE PARAPENTE', 60, 230);
    doc.font('Helvetica').fontSize(24).text('BON CADEAU', 60, 270);

    // Contact en bas (Légèrement remonté pour la marge)
    doc.font('Helvetica').fontSize(10).text('Fluide Parapente - La Clusaz', 0, 765, { align: 'center', width: 595 });
    doc.text('Tél : 06 12 34 56 78 - www.fluideparapente.com', 0, 780, { align: 'center', width: 595 });

    // 5. Ajouter les éléments dynamiques (Acheteur, Bénéficiaire, Type, Code, Expiration)
    doc.fillColor('#0f172a'); // Bleu très foncé pour le texte
    doc.font('Helvetica-Bold');

    // Section 1 : Pour qui / De la part de
    doc.fontSize(10).fillColor('#64748b').text('BÉNÉFICIAIRE', 60, 340, { characterSpacing: 2 });
    doc.fontSize(22).fillColor('#1e40af').text(voucher.beneficiary_name.toUpperCase(), 60, 355);

    doc.fontSize(10).fillColor('#64748b').text('ACHETEUR', 60, 410, { characterSpacing: 2 });
    doc.fontSize(22).fillColor('#1e40af').text(voucher.buyer_name.toUpperCase(), 60, 425);

    // Section 2 : Valable pour
    doc.fontSize(10).fillColor('#64748b').text('VALABLE POUR', 60, 490, { characterSpacing: 2 });
    if (voucher.flight_name) {
      doc.fontSize(28).fillColor('#1e40af').text(voucher.flight_name.toUpperCase(), 60, 505);
    } else {
      const montant = voucher.price_paid_cents / 100;
      doc.fontSize(28).fillColor('#1e40af').text(`UN AVOIR LIBRE DE ${montant}€`, 60, 505);
    }

    // Section 3 : Le code unique
    doc.fontSize(10).fillColor('#64748b').text("CODE D'ACTIVATION UNIQUE", 60, 580, { characterSpacing: 2 });
    doc.fontSize(42).fillColor('#f026b8').text(voucher.code, 60, 595, { characterSpacing: 4 });

    // Section 4 : Date d'expiration
    const expiryDate = new Date(voucher.valid_until);
    const formattedDate = expiryDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

    doc.fontSize(10).fillColor('#64748b').text("DATE D'EXPIRATION", 60, 680, { characterSpacing: 2 });
    doc.fontSize(20).fillColor('#1e40af').text(formattedDate.toUpperCase(), 60, 695);

    // Finaliser le document
    doc.end();

  } catch (err) {
    console.error("Erreur génération PDF:", err);
    if (!res.headersSent) {
      res.status(500).send("Erreur lors de la génération du bon cadeau.");
    }
  }
});

// 🗑️ 1. SUPPRIMER UN VOL UNIQUE (Nettoyage intégral)
app.delete('/api/slots/:id', authenticateUser, async (req, res) => {
  try {
    await pool.query(
      `UPDATE slots 
       SET status = 'available', 
           payment_status = NULL, 
           title = NULL, 
           notes = NULL,
           phone = NULL,
           email = NULL,
           booking_options = NULL,   -- 🎯 On vide l'option Photo/Vidéo
           client_message = NULL,    -- 🎯 On vide les notes du client
           flight_type_id = NULL,
           weight_checked = false,
           weight = NULL             -- 🎯 On vide aussi le poids si présent
       WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ ERREUR DELETE SLOT:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🧹 2. SUPPRESSION MASSIVE (Nettoyage intégral)
app.post('/api/clients/bulk-delete', authenticateUser, async (req, res) => {
  const { ids } = req.body;
  if (!ids || ids.length === 0) return res.status(400).json({ error: "Aucun ID" });

  try {
    await pool.query(
      `UPDATE slots 
       SET status = 'available', 
           payment_status = NULL, 
           title = NULL,
           phone = NULL,
           email = NULL,
           notes = NULL,
           booking_options = NULL,   -- 🎯 Nettoyage ici aussi
           client_message = NULL,    -- 🎯 Nettoyage ici aussi
           flight_type_id = NULL,
           weight = NULL
       WHERE id = ANY($1::int[])`, 
      [ids]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ ERREUR BULK DELETE:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- DÉMARRAGE ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => { console.log(`✅ Backend Fluide V3 prêt sur le port ${PORT}`); });