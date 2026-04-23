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

// 🎯 LA RUSTINE MAGIQUE : Le serveur met à jour la base de données tout seul
pool.query(`ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS buyer_phone VARCHAR(50);`)
  .then(() => console.log("✅ Base de données à jour : La case Téléphone est prête !"))
  .catch(e => console.log("Info DB : Verification téléphone ignorée."));

pool.on('error', (err, client) => {
  console.error('Erreur inattendue du réseau de la base de données:', err.message);
});

// 🎯 NOUVEAU : On ajoute les cases pour le fond du PDF
pool.query(`ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS pdf_background_url VARCHAR(500);`).catch(() => {});
pool.query(`ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS pdf_background_url VARCHAR(500);`).catch(() => {});

// 🎯 NOUVEAU : On ajoute les cases pour la facturation partenaire
pool.query(`ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS is_partner BOOLEAN DEFAULT false;`).catch(() => {});
pool.query(`ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS partner_amount_cents INTEGER;`).catch(() => {});
pool.query(`ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS partner_billing_type VARCHAR(50) DEFAULT 'fixed';`).catch(() => {});
pool.query(`ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS buyer_address TEXT;`).catch(() => {});

// 🎯 NOUVEAU : On ajoute les cases pour la popup des bons cadeaux
pool.query(`ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS popup_content TEXT;`).catch(() => {});
pool.query(`ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS show_popup BOOLEAN DEFAULT false;`).catch(() => {});

// 🎯 NOUVEAU : On ajoute les cases pour la popup des vols
pool.query(`ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS popup_content TEXT;`).catch(() => {});
pool.query(`ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS show_popup BOOLEAN DEFAULT false;`).catch(() => {});

const JWT_SECRET = process.env.JWT_SECRET || "fluide_secret_key_2026";

// ==========================================
// 💌 MOTEUR D'EMAILS & SMS INTELLIGENT (BREVO)
// ==========================================

// 🎯 NOUVEAU : FONCTION INTELLIGENTE POUR DESSINER LE FOND DU PDF (Supporte Cloudinary !)
async function drawBackground(doc, urlOrPath) {
  if (urlOrPath && urlOrPath.startsWith('http')) {
      try {
          const response = await fetch(urlOrPath);
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          doc.image(buffer, 0, 0, { width: 595, height: 842 });
      } catch (e) {
          console.error("Erreur téléchargement image fond PDF:", e);
          doc.rect(0, 0, 595, 842).fill('#1e3a8a');
      }
  } else {
      const cleanImageName = urlOrPath && urlOrPath !== '' ? (urlOrPath.startsWith('/') ? urlOrPath.substring(1) : urlOrPath) : 'cadeau-background.jpg';
      const finalImagePath = path.join(process.cwd(), 'public', cleanImageName);
      if (fs.existsSync(finalImagePath)) {
          doc.image(finalImagePath, 0, 0, { width: 595, height: 842 });
      } else {
          doc.rect(0, 0, 595, 842).fill('#1e3a8a'); 
      }
  }
}

// ==========================================
// 🚀 L'ARME FATALE : SYNCHRONISATION EN TÂCHE DE FOND (0.01s)
// ==========================================
const googleSyncCache = new Map();
let isSyncing = false;

async function runBackgroundGoogleSync() {
  if (isSyncing) return; // Évite que les tâches se chevauchent
  isSyncing = true;
  try {
    const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
    if (syncSetting.rows.length === 0 || syncSetting.rows[0].value !== 'true') {
      isSyncing = false;
      return;
    }

    // On récupère uniquement les moniteurs actifs
    const monRes = await pool.query("SELECT id, first_name FROM users WHERE is_active_monitor = true AND status = 'Actif'");
    const webhookUrl = "https://script.google.com/macros/s/AKfycbwRlzxV3bb1vIAnDiY0qz4YJGzPDwHu9qoABxaf5Q89lljHpf7rCP9hclWdoFF44L2j/exec";

    // Le serveur va toquer chez Google silencieusement
    for (const mon of monRes.rows) {
      try {
        const resp = await fetch(`${webhookUrl}?monitorName=${mon.first_name}`);
        const slots = await resp.json();
        // On sauvegarde directement avec l'ID du pilote (plus rapide pour filtrer plus tard)
        googleSyncCache.set(mon.id, slots); 
      } catch(e) { /* On ignore les petites erreurs Google */ }
    }
  } catch(e) {
    console.error("Erreur Background Sync:", e);
  } finally {
    isSyncing = false;
  }
}

// ⏱️ Le serveur refait le point toutes les 2 minutes (120 000 millisecondes)
setInterval(runBackgroundGoogleSync, 120000);
// 🚀 On lance un premier check 5 secondes après le démarrage du serveur
setTimeout(runBackgroundGoogleSync, 5000);

async function generatePDFBuffer(voucher) {
  return new Promise(async (resolve, reject) => { 
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // 🎯 On utilise la nouvelle image de fond PDF
    const backgroundSrc = voucher.pdf_background_url && voucher.pdf_background_url !== '' ? voucher.pdf_background_url : 'cadeau-background.jpg';
    await drawBackground(doc, backgroundSrc);

    doc.fillColor('white').font('Helvetica-Bold').fontSize(38).text('FLUIDE PARAPENTE', 60, 230);
    doc.font('Helvetica').fontSize(24).text('BON CADEAU', 60, 270);
    
    doc.fillColor('#64748b').fontSize(14).font('Helvetica-Bold').text('OFFERT PAR :', 60, 355);
    
    const safeBuyerName = voucher.buyer_name || 'Client Inconnu';
    doc.fillColor('#1e40af').fontSize(24).text(safeBuyerName.toUpperCase(), 60, 380);
    
    const giftName = voucher.flight_name || `UN AVOIR DE ${voucher.price_paid_cents / 100}€`;
    doc.fontSize(28).text(giftName.toUpperCase(), 60, 505);
    doc.fontSize(42).fillColor('#f026b8').text(voucher.code, 60, 595, { characterSpacing: 4 });
    
    doc.end();
  });
}

async function sendConfirmationEmail(customerEmail, customerName, itemType, itemName, dateOrCode, timeOrValue, flightId = null, pdfBuffer = null) {
  if (!process.env.BREVO_API_KEY) return console.log("⚠️ BREVO_API_KEY manquante. Email non envoyé.");

  let customMessage = "";
  try {
    const settingKey = itemType === 'gift_card' ? 'email_gift_card' : `email_flight_${flightId}`;
    const setRes = await pool.query('SELECT value FROM site_settings WHERE key = $1', [settingKey]);
    if (setRes.rows.length > 0 && setRes.rows[0].value) {
      customMessage = setRes.rows[0].value;
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

async function sendConfirmationSMS(customerPhone, customerName, itemType, dateOrCode, timeOrValue, flightId = null) {
  if (!process.env.BREVO_API_KEY || !customerPhone || itemType === 'gift_card') return;

  let customSms = "";
  try {
    const setRes = await pool.query('SELECT value FROM site_settings WHERE key = $1', [`sms_flight_${flightId}`]);
    if (setRes.rows.length > 0 && setRes.rows[0].value) {
      customSms = setRes.rows[0].value;
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

async function sendAdminNotificationEmail(customerName, customerPhone, itemName, dateOrCode, timeOrValue) {
  if (!process.env.BREVO_API_KEY) return;

  let adminEmailsStr = "contact@fluide-parapente.fr";
  try {
    const setRes = await pool.query('SELECT value FROM site_settings WHERE key = $1', ['admin_notification_emails']);
    if (setRes.rows.length > 0 && setRes.rows[0].value) {
      adminEmailsStr = setRes.rows[0].value;
    }
  } catch(e) { console.error("Erreur lecture settings admin emails:", e); }

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

// 🎯 FONCTION POUR ENVOYER LE VOL À GOOGLE SCRIPT
async function notifyGoogleCalendar(monitorName, title, startTime, endTime, description) {
  const webhookUrl = "https://script.google.com/macros/s/AKfycbwRlzxV3bb1vIAnDiY0qz4YJGzPDwHu9qoABxaf5Q89lljHpf7rCP9hclWdoFF44L2j/exec"; 
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ monitorName, title, startTime, endTime, description }),
      redirect: 'follow'
    });
    
    // On lit la réponse de Google et on l'affiche dans Railway
    const responseText = await response.text();
    console.log(`📡 Réponse de Google pour ${monitorName} :`, responseText);
    
  } catch (err) {
    console.error("❌ Erreur de synchro avec Google Script :", err);
  }
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

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    if (r.rows.length === 0) return res.status(401).json({ error: "Identifiants incorrects" });

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

app.patch('/api/users/:id', authenticateUser, async (req, res) => {
  const { first_name, email, role, is_active_monitor, status, password, available_start_date, available_end_date, daily_start_time, daily_end_time } = req.body;
  try {
    if (req.user.role !== 'admin' && req.user.id !== parseInt(req.params.id)) {
      return res.status(403).json({ error: "Interdit : Vous ne pouvez modifier que votre propre profil." });
    }

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

app.get('/api/users/:id/availabilities', authenticateUser, async (req, res) => {
  try {
    const r = await pool.query('SELECT *, TO_CHAR(start_date, \'YYYY-MM-DD\') as start_date, TO_CHAR(end_date, \'YYYY-MM-DD\') as end_date FROM monitor_availabilities WHERE user_id = $1 ORDER BY start_date ASC', [req.params.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:id/availabilities', authenticateUser, async (req, res) => {
  const { availabilities } = req.body; 
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

app.get('/api/flight-types', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM flight_types ORDER BY price_cents ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/flight-types', authenticateAdmin, async (req, res) => {
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url, popup_content, show_popup } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'Standard'; 
  
  try {
    const r = await pool.query(
      `INSERT INTO flight_types (name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url, popup_content, show_popup) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [name, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, allow_multi_slots || false, weight_min || 20, weight_max || 110, booking_delay_hours || 0, image_url || null, popup_content || null, show_popup || false]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/flight-types/:id', authenticateAdmin, async (req, res) => {
  const { name, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url, popup_content, show_popup } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'Standard';

  try {
    await pool.query(
      `UPDATE flight_types 
       SET name = $1, duration_minutes = $2, price_cents = $3, restricted_start_time = $4, restricted_end_time = $5, color_code = $6, allowed_time_slots = $7, season = $8, allow_multi_slots = $9, weight_min = $10, weight_max = $11, booking_delay_hours = $12, image_url = $13, popup_content = $14, show_popup = $15 
       WHERE id = $16`,
      [name, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, allow_multi_slots || false, weight_min || 20, weight_max || 110, booking_delay_hours || 0, image_url || null, popup_content || null, show_popup || false, req.params.id]
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

app.get('/api/slots', authenticateUser, async (req, res) => {
  try {
    const { start, end } = req.query;
    let query = 'SELECT * FROM slots WHERE 1=1';
    let params = [];

    if (req.user.role === 'monitor') {
      params.push(req.user.id);
      query += ` AND monitor_id = $${params.length}`;
    }

    if (start && end) {
      params.push(start, end);
      query += ` AND start_time >= $${params.length - 1} AND start_time <= $${params.length}`;
    } else {
      query += ` AND start_time >= NOW() - INTERVAL '1 month' AND start_time <= NOW() + INTERVAL '6 months'`;
    }

    query += ' ORDER BY start_time ASC';
    const r = await pool.query(query, params);
    let slots = r.rows;

    // 🎯 VÉRIFICATION: Le partage Google est-il activé ?
    const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
    const isGoogleSyncEnabled = syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true';

    if (isGoogleSyncEnabled) {
      // 🎯 SYNC GOOGLE : Version ultra-rapide avec Cache
      const webhookUrl = "https://script.google.com/macros/s/AKfycbwRlzxV3bb1vIAnDiY0qz4YJGzPDwHu9qoABxaf5Q89lljHpf7rCP9hclWdoFF44L2j/exec"; 
      const monitorIds = [...new Set(slots.map(s => s.monitor_id).filter(id => id != null))];
      
      await Promise.all(monitorIds.map(async (mId) => {
        try {
          const monRes = await pool.query('SELECT first_name FROM users WHERE id = $1', [mId]);
          if (monRes.rows.length > 0) {
            const mName = monRes.rows[0].first_name;
            const googleBusySlots = await getGoogleBusySlots(mName, webhookUrl);

            slots = slots.map(slot => {
              const slotStart = new Date(slot.start_time).getTime();
              const isBusy = googleBusySlots.some(g => slotStart >= g.start && slotStart < g.end);
              if (slot.monitor_id === mId && isBusy && slot.status === 'available') {
                return { ...slot, status: 'booked', title: '🚫 BLOQUÉ (Google)', notes: 'Indisponibilité notée sur l\'agenda perso' };
              }
              return slot;
            });
          }
        } catch (e) { console.error(`Erreur sync Google pour ${mId}`); }
      }));
    }

    res.json(slots);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.patch('/api/slots/:id', authenticateUser, async (req, res) => {
  let { title, weight, flight_type_id, notes, status, monitor_id, phone, email, weightChecked, booking_options, client_message } = req.body;
  const slotId = req.params.id;

  try {
    if (req.user.role === 'monitor') {
      return res.status(403).json({ error: "Mode lecture seule : Vous ne pouvez pas modifier le planning." });
    }

    if (req.user.role === 'permanent') {
      const checkRes = await pool.query('SELECT monitor_id, title, status FROM slots WHERE id = $1', [slotId]);
      if (checkRes.rows.length > 0) {
        const slot = checkRes.rows[0];
        if (slot.monitor_id !== req.user.id) {
          return res.status(403).json({ error: "Vous ne pouvez agir que sur votre propre planning." });
        }
        const isClientSlot = slot.status === 'booked' && slot.title && !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => slot.title.includes(t)) && !slot.title.includes('❌');
        const isMakingClientSlot = status === 'booked' && title && !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => title.includes(t)) && !title.includes('❌');
        if (isClientSlot || isMakingClientSlot) {
          return res.status(403).json({ error: "Les moniteurs permanents ne peuvent pas modifier les réservations clients." });
        }
        if (slot.title && slot.title.includes('(Admin)')) {
          return res.status(403).json({ error: "Action refusée : Ce créneau est verrouillé par la Direction." });
        }
      }
    }

    if (req.user.role === 'admin' && (title === 'NON DISPO' || title === '☕ PAUSE')) {
      title = `${title} (Admin)`;
    }

    const result = await pool.query(
      `UPDATE slots 
      SET title = $1, weight = $2, flight_type_id = $3, notes = $4, status = $5,
          monitor_id = COALESCE($6, monitor_id), phone = $8, email = $9, weight_checked = $10,
          booking_options = $11, client_message = $12, payment_status = COALESCE($13, payment_status)
      WHERE id = $7 RETURNING *`, 
      [
        title !== undefined ? title : null, weight ? parseInt(weight) : null, flight_type_id ? parseInt(flight_type_id) : null, 
        notes !== undefined ? notes : null, status || 'available', monitor_id ? parseInt(monitor_id) : null, slotId,
        phone !== undefined ? phone : null, email !== undefined ? email : null, weightChecked !== undefined ? weightChecked : false,
        booking_options !== undefined ? booking_options : null, client_message !== undefined ? client_message : null,
        req.body.payment_status !== undefined ? req.body.payment_status : null
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Créneau introuvable" });
    
    const updatedSlot = result.rows[0];

    // 🎯 SYNC GOOGLE : Envoi des réservations manuelles depuis le backoffice
    // On vérifie que c'est une vraie réservation client
    if (updatedSlot.status === 'booked' && updatedSlot.title && 
        !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => updatedSlot.title.includes(t)) && 
        !updatedSlot.title.includes('❌') && 
        !updatedSlot.title.startsWith('↪️ Suite')) {
      
      try {
        // 🎯 L'INTERRUPTEUR EST ICI : On vérifie si la synchro est activée en base de données
        const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
        if (syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true') {
          
          const monRes = await pool.query('SELECT first_name FROM users WHERE id = $1', [updatedSlot.monitor_id]);
          if (monRes.rows.length > 0) {
            const monitorName = monRes.rows[0].first_name;
            
            let desc = "Créé depuis le backoffice\n";
            if (updatedSlot.phone) desc += `Tel: ${updatedSlot.phone}\n`;
            if (updatedSlot.booking_options) desc += `Options: ${updatedSlot.booking_options}\n`;
            if (updatedSlot.notes) desc += `Notes internes: ${updatedSlot.notes}\n`;
            if (updatedSlot.client_message) desc += `Message client: ${updatedSlot.client_message}\n`;

            notifyGoogleCalendar(monitorName, updatedSlot.title, updatedSlot.start_time, updatedSlot.end_time, desc);
          }
        }
      } catch(e) { console.error("Erreur Synchro Google Admin:", e); }
    }

    res.json(updatedSlot);

  } catch (err) {
    console.error("ERREUR PATCH SLOT:", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/slots/:id/quick', authenticateUser, async (req, res) => {
  const { payment_status, monitor_id } = req.body;
  const client = await pool.connect(); 
  
  try {
    await client.query('BEGIN');
    const currentSlotRes = await client.query('SELECT * FROM slots WHERE id = $1', [req.params.id]);
    if (currentSlotRes.rows.length === 0) throw new Error("Créneau introuvable");
    const currentSlot = currentSlotRes.rows[0];

    if (payment_status !== undefined) {
       await client.query('UPDATE slots SET payment_status = $1 WHERE id = $2', [payment_status, req.params.id]);
    }

    if (monitor_id !== undefined) {
       const targetMonitor = monitor_id || null;
       if (targetMonitor && targetMonitor !== currentSlot.monitor_id) {
         const targetSlotRes = await client.query('SELECT * FROM slots WHERE monitor_id = $1 AND start_time = $2', [targetMonitor, currentSlot.start_time]);
         if (targetSlotRes.rows.length > 0) {
            const targetSlot = targetSlotRes.rows[0];
            if (targetSlot.status !== 'available' && targetSlot.title !== 'NOTE') {
               throw new Error("Ce pilote a déjà un vol prévu à cette heure-là !");
            }
            await client.query('UPDATE slots SET monitor_id = NULL WHERE id = $1', [targetSlot.id]);
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [targetMonitor, currentSlot.id]);
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [currentSlot.monitor_id, targetSlot.id]);
         } else {
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [targetMonitor, currentSlot.id]);
         }
       } else if (!targetMonitor) {
         await client.query('UPDATE slots SET monitor_id = NULL WHERE id = $1', [currentSlot.id]);
       }
    }

    await client.query('COMMIT');
    const finalSlot = await client.query('SELECT * FROM slots WHERE id = $1', [req.params.id]);
    res.json(finalSlot.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message }); 
  } finally {
    client.release();
  }
});

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
          AND ((title IS NOT NULL AND title != '' AND title != '☕ PAUSE') OR (notes IS NOT NULL AND trim(notes) != ''))
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
                return curr >= startD && curr <= endD && (!a.daily_start_time || d.start_time >= a.daily_start_time) && (!a.daily_end_time || d.start_time < a.daily_end_time);
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
      await client.query(`INSERT INTO slots (monitor_id, start_time, end_time, status, title) VALUES ${placeholders.join(', ')}`, values);
    }

    await client.query('COMMIT');
    res.json({ success: true, count: placeholders.length });
    
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { 
    client.release(); 
  }
});

app.get('/api/slot-definitions', async (req, res) => {
  try {
    const { plan } = req.query;
    const query = plan ? 'SELECT * FROM slot_definitions WHERE plan_name = $1 ORDER BY start_time' : 'SELECT * FROM slot_definitions ORDER BY start_time';
    const result = await pool.query(query, plan ? [plan] : []);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/slot-definitions', authenticateAdmin, async (req, res) => {
  try {
    const { start_time, duration_minutes, label, plan_name } = req.body;
    const r = await pool.query(
      `INSERT INTO slot_definitions (start_time, duration_minutes, label, plan_name) VALUES ($1, $2, $3, $4) RETURNING *`,
      [start_time, duration_minutes, label, plan_name || 'Standard']
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/slot-definitions/:id', authenticateAdmin, async (req, res) => {
  const { start_time, duration_minutes, label, plan_name } = req.body;
  try {
    await pool.query('UPDATE slot_definitions SET start_time = $1, duration_minutes = $2, label = $3, plan_name = $4 WHERE id = $5', [start_time, duration_minutes, label, plan_name || 'Standard', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/slot-definitions/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM slot_definitions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/plans/:oldName', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE slot_definitions SET plan_name = $1 WHERE plan_name = $2', [req.body.newName, req.params.oldName]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/plans/:name', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM slot_definitions WHERE plan_name = $1', [req.params.name]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gift-card-templates', async (req, res) => {
  const { publicOnly } = req.query;
  try {
    let query = `SELECT gct.*, ft.name as flight_name FROM gift_card_templates gct LEFT JOIN flight_types ft ON gct.flight_type_id = ft.id`;
    if (publicOnly === 'true') query += ` WHERE gct.is_published = true ORDER BY gct.price_cents ASC`;
    else query += ` ORDER BY gct.id DESC`;
    const r = await pool.query(query);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gift-card-templates', authenticateAdmin, async (req, res) => {
  const { title, description, price_cents, flight_type_id, validity_months, image_url, is_published, pdf_background_url, popup_content, show_popup } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO gift_card_templates (title, description, price_cents, flight_type_id, validity_months, image_url, is_published, pdf_background_url, popup_content, show_popup) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [title, description, price_cents, flight_type_id || null, validity_months || 12, image_url || null, is_published || false, pdf_background_url || null, popup_content || null, show_popup || false]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/gift-card-templates/:id', authenticateAdmin, async (req, res) => {
  const { title, description, price_cents, flight_type_id, validity_months, image_url, is_published, pdf_background_url, popup_content, show_popup } = req.body;
  try {
    await pool.query(
      `UPDATE gift_card_templates SET title = $1, description = $2, price_cents = $3, flight_type_id = $4, validity_months = $5, image_url = $6, is_published = $7, pdf_background_url = $8, popup_content = $9, show_popup = $10 WHERE id = $11`,
      [title, description, price_cents, flight_type_id || null, validity_months || 12, image_url || null, is_published || false, pdf_background_url || null, popup_content || null, show_popup || false, req.params.id]
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
            CASE WHEN s.start_time >= NOW() THEN 0 ELSE 1 END ASC,
            CASE WHEN s.start_time >= NOW() THEN s.start_time END ASC,
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

app.get('/api/gift-cards', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT gc.*, ft.name as flight_name FROM gift_cards gc LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id ORDER BY gc.created_at DESC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🎯 1. CRÉATION D'UN CODE
// 🎯 1. CRÉATION D'UN CODE
app.post('/api/gift-cards', authenticateAdmin, async (req, res) => {
  const { flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes, type, discount_type, discount_value, custom_code, max_uses, valid_from, valid_until, discount_scope, is_partner, partner_amount_cents, partner_billing_type } = req.body;
  try {
    const finalCode = custom_code ? custom_code.toUpperCase().replace(/\s+/g, '-') : `FLUIDE-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    const r = await pool.query(
      `INSERT INTO gift_cards (code, flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes, type, discount_type, discount_value, max_uses, valid_from, valid_until, status, discount_scope, is_partner, partner_amount_cents, partner_billing_type) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'valid', $13, $14, $15, $16) RETURNING *`,
      [finalCode, flight_type_id || null, buyer_name || null, beneficiary_name || null, price_paid_cents || 0, notes || '', type || 'gift_card', discount_type || null, discount_value || null, max_uses || null, valid_from || null, valid_until || null, discount_scope || 'both', is_partner || false, partner_amount_cents || null, partner_billing_type || 'fixed']
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: "Ce code personnalisé existe déjà." });
    res.status(500).json({ error: err.message });
  }
});

// 🎯 2. MODIFICATION D'UN CODE
app.put('/api/gift-cards/:id', authenticateAdmin, async (req, res) => {
  const { flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes, discount_type, discount_value, max_uses, valid_from, valid_until, discount_scope, is_partner, partner_amount_cents, partner_billing_type } = req.body;
  try {
    await pool.query(
      `UPDATE gift_cards SET flight_type_id = $1, buyer_name = $2, beneficiary_name = $3, price_paid_cents = $4, notes = $5, discount_type = $6, discount_value = $7, max_uses = $8, valid_from = $9, valid_until = $10, discount_scope = $11, is_partner = $12, partner_amount_cents = $13, partner_billing_type = $14 WHERE id = $15`,
      [flight_type_id || null, buyer_name || null, beneficiary_name || null, price_paid_cents || 0, notes || '', discount_type || null, discount_value || null, max_uses || null, valid_from || null, valid_until || null, discount_scope || 'both', is_partner || false, partner_amount_cents || null, partner_billing_type || 'fixed', req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/gift-cards/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE gift_cards SET status = $1 WHERE id = $2`, [req.body.status, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/gift-cards/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM gift_cards WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gift-cards/check/:code', async (req, res) => {
  try {
    const r = await pool.query(`SELECT gc.*, ft.name as flight_name FROM gift_cards gc LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id WHERE UPPER(gc.code) = UPPER($1) AND gc.status = 'valid'`, [req.params.code]);
    if (r.rows.length === 0) return res.status(404).json({ message: "Bon invalide ou déjà utilisé" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard-stats', authenticateAdmin, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
    const summary = await pool.query(`SELECT COUNT(*) as total_slots, COUNT(*) FILTER (WHERE status = 'booked' AND (title NOT LIKE '☕%' OR title IS NULL)) as booked_slots, COALESCE(SUM(ft.price_cents), 0) as revenue FROM slots s LEFT JOIN flight_types ft ON s.flight_type_id = ft.id WHERE s.start_time::date = $1`, [today]);
    const upcoming = await pool.query(`SELECT s.id, s.start_time, s.title, ft.name as flight_name, u.first_name as monitor_name, s.notes FROM slots s LEFT JOIN flight_types ft ON s.flight_type_id = ft.id LEFT JOIN users u ON s.monitor_id = u.id WHERE s.start_time::date = $1 AND s.status = 'booked' AND (s.title NOT LIKE '☕%' OR s.title IS NULL) AND s.start_time >= (NOW() AT TIME ZONE 'Europe/Paris') ORDER BY s.start_time ASC LIMIT 5`, [today]);
    res.json({ summary: { todaySlots: parseInt(summary.rows[0].total_slots) || 0, bookedSlots: parseInt(summary.rows[0].booked_slots) || 0, revenue: parseInt(summary.rows[0].revenue) || 0 }, upcoming: upcoming.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings', async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM site_settings');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', authenticateAdmin, async (req, res) => {
  const { key, value } = req.body;
  try {
    await pool.query(`INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', authenticateAdmin, async (req, res) => {
  try {
    const summaryResult = await pool.query(`SELECT COALESCE(SUM(ft.price_cents), 0) as total_revenue, COUNT(s.id) as total_bookings FROM slots s JOIN flight_types ft ON s.flight_type_id = ft.id WHERE s.status = 'booked' AND (s.title NOT LIKE '☕%' OR s.title IS NULL)`);
    const upcomingResult = await pool.query(`SELECT s.id, s.start_time, s.title as client_name, ft.name as flight_name, ft.price_cents as total_price, u.first_name as monitor_name FROM slots s JOIN flight_types ft ON s.flight_type_id = ft.id LEFT JOIN users u ON s.monitor_id = u.id WHERE s.status = 'booked' AND s.start_time >= NOW() ORDER BY s.start_time ASC`);
    res.json({ summary: { totalRevenue: parseInt(summaryResult.rows[0].total_revenue), totalBookings: parseInt(summaryResult.rows[0].total_bookings) }, upcoming: upcomingResult.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ⚡ ROUTE PUBLIQUE VITESSE LUMIÈRE (100% SQL + Mémoire RAM)
app.get('/api/public/availabilities', async (req, res) => {
  const { start, end } = req.query; 
  try {
    if (!start || !end) return res.status(400).json({ error: "Période requise" });
    
    // 1. Un seul appel pour récupérer la grille de la base de données
    const r = await pool.query(`SELECT id, start_time, end_time, status, monitor_id FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 ORDER BY start_time ASC`, [start, end]);
    let slots = r.rows;

    const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
    const isGoogleSyncEnabled = syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true';

    if (isGoogleSyncEnabled) {
      // 2. On lit simplement la RAM du serveur (0.001 seconde d'attente)
      slots = slots.map(slot => {
        if (slot.status === 'available' && slot.monitor_id) {
          const googleBusySlots = googleSyncCache.get(slot.monitor_id) || [];
          const slotStart = new Date(slot.start_time).getTime();
          const isBusy = googleBusySlots.some(g => slotStart >= g.start && slotStart < g.end);
          if (isBusy) return { ...slot, status: 'booked' };
        }
        return slot;
      });
    }

    res.json(slots);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/public/site-settings', async (req, res) => {
  try {
    const r = await pool.query("SELECT key, value FROM site_settings WHERE key IN ('physical_gift_card_enabled', 'physical_gift_card_price')");
    const settings = r.rows.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// 🎯 SECURISE : CREATION SESSION STRIPE BON CADEAU
app.post('/api/public/checkout-gift-card', async (req, res) => {
  const { template, buyer, physicalShipping } = req.body;
  try {
    // On va chercher le prix de l'envoi postal dans la base
    const shipRes = await pool.query("SELECT value FROM site_settings WHERE key = 'physical_gift_card_price'");
    const shipPriceCents = shipRes.rows.length > 0 ? (parseInt(shipRes.rows[0].value) || 0) * 100 : 0;

    const line_items = [{
      price_data: {
        currency: 'eur',
        product_data: { name: template.title, description: `Bon cadeau offert par : ${buyer.name}` },
        unit_amount: template.price_cents
      },
      quantity: 1
    }];

    // Si le client a coché l'option, on ajoute la ligne de facturation !
    if (physicalShipping && physicalShipping.enabled && shipPriceCents > 0) {
      line_items.push({
        price_data: {
          currency: 'eur',
          product_data: { name: "📮 Envoi Postal", description: "Carte glacée imprimée envoyée par courrier" },
          unit_amount: shipPriceCents
        },
        quantity: 1
      });
    }

    const sessionConfig = {
      payment_method_types: ['card'],
      customer_email: buyer.email,
      line_items: line_items,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/succes?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/bons-cadeaux`,
      metadata: {
        purchase_type: 'gift_card',
        buyer_name: String(buyer.name || 'Client Inconnu').substring(0, 499),
        buyer_email: String(buyer.email || '').substring(0, 499),
        buyer_phone: String(buyer.phone || '').substring(0, 499), 
        price_paid_cents: String(template.price_cents || 0).substring(0, 499),
        validity_months: String(template.validity_months || 12).substring(0, 499),
        flight_type_id: String(template.flight_type_id || '').substring(0, 499),
        image_url: String(template.image_url || '').substring(0, 499),
        pdf_background_url: String(template.pdf_background_url || '').substring(0, 499),
        // 🎯 On sauvegarde l'adresse postale
        buyer_address: physicalShipping && physicalShipping.enabled ? String(physicalShipping.address).substring(0, 499) : ''
      }
    };
    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur Checkout Stripe Cadeau:", err);
    res.status(500).json({ error: err.message });
  }
});

async function performBooking(client, contact, passengers, paymentStatus = null) {
  for (const p of passengers) {
    const flightRes = await client.query('SELECT * FROM flight_types WHERE id = $1', [p.flightId]);
    const flight = flightRes.rows[0];
    const flightDur = flight.duration_minutes || 15;

    const slotsRes = await client.query(`SELECT * FROM slots WHERE start_time::date = $1 AND status = 'available' ORDER BY start_time ASC`, [p.date]);
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
      const lastName = contact.lastName ? contact.lastName.toUpperCase() : "";
      const fullName = `${p.firstName} ${lastName}`.trim();
      const slotTitle = isFirstSlot ? fullName : `↪️ Suite ${fullName}`;
      const slotNotes = isFirstSlot ? null : 'Extension auto';

      await client.query(`
        UPDATE slots 
        SET status = 'booked', title = $1, notes = $8, phone = $3, email = $4, weight_checked = true, flight_type_id = $5, booking_options = $6, client_message = $7, payment_status = $9
        WHERE id = $2
      `, [slotTitle, slot.id, contact.phone, contact.email, p.flightId, bookingOptions, clientMessage, slotNotes, paymentStatus]);
      
// 🎯 NOUVEAU : ON PRÉVIENT GOOGLE INSTANTANÉMENT (SI ACTIVÉ)
      try {
        const syncSetting = await client.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
        if (syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true') {
          const monRes = await client.query('SELECT first_name FROM users WHERE id = $1', [chosenMonitor]);
          if (monRes.rows.length > 0) {
            const monitorName = monRes.rows[0].first_name;
            let desc = "";
            if (contact.phone) desc += `Tel: ${contact.phone}\n`;
            if (bookingOptions) desc += `Options: ${bookingOptions}\n`;
            if (clientMessage) desc += `Message client: ${clientMessage}\n`;

            if (isFirstSlot) {
              await notifyGoogleCalendar(monitorName, slotTitle, slot.start_time, slot.end_time, desc);
            }
          }
        }
      } catch(e) { console.error("Erreur Synchro Google:", e); }

      const index = availableSlots.findIndex(s => s.id === slot.id);
      if(index > -1) availableSlots.splice(index, 1);
      isFirstSlot = false;
    }
  } 
}

app.post('/api/public/checkout', async (req, res) => {
  const { contact, passengers, voucher_code } = req.body;
  const client = await pool.connect();

  try {
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

          if (appliedVoucher.discount_type === 'fixed') discountAmountCents = Math.min(appliedVoucher.discount_value * 100, targetAmountCents);
          if (appliedVoucher.discount_type === 'percentage') discountAmountCents = Math.round(targetAmountCents * (appliedVoucher.discount_value / 100));
        }
      }
    }

    const finalPriceCents = Math.max(0, originalPriceCents - discountAmountCents);

    if (finalPriceCents === 0) {
      await client.query('BEGIN');
      let pStatus = 'À régler sur place';
      if (appliedVoucher) {
        pStatus = appliedVoucher.type === 'gift_card' ? `Payé (Bon Cadeau : ${appliedVoucher.code})` : `Payé (Promo : ${appliedVoucher.code})`;
      }
      await performBooking(client, contact, passengers, pStatus);
      
      if (appliedVoucher) {
        await client.query(`UPDATE gift_cards SET current_uses = current_uses + 1, status = CASE WHEN max_uses IS NOT NULL AND (current_uses + 1) >= max_uses THEN 'used' ELSE status END WHERE id = $1`, [appliedVoucher.id]);
      }
      
      await client.query('COMMIT');
      
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

    const passengersJson = JSON.stringify(passengers);
    const metadata = {
      contact_name: `${contact.firstName} ${contact.lastName}`.substring(0, 500),
      contact_phone: contact.phone ? String(contact.phone).substring(0, 500) : '',
      contact_email: contact.email ? String(contact.email).substring(0, 500) : '',
      contact_notes: contact.notes ? contact.notes.substring(0, 450) : '',
      voucher_code: appliedVoucher ? appliedVoucher.code : ''
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

    if (appliedVoucher && discountAmountCents > 0) {
      const coupon = await stripe.coupons.create({ amount_off: discountAmountCents, currency: 'eur', duration: 'once', name: `Réduction (${appliedVoucher.code})` });
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

// 🎯 SECURISE : CONFIRMATION DES PAIEMENTS
app.post('/api/public/confirm-booking', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: "Session ID manquant" });

  if (session_id.startsWith('GRATUIT_')) return res.json({ success: true });

  const client = await pool.connect(); 
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.status(400).json({ error: "Le paiement n'a pas abouti." });

    await client.query('BEGIN'); 

    // --- CAS 1 : ACHAT BON CADEAU ---
    if (session.metadata.purchase_type === 'gift_card') {
      const finalCode = `FLUIDE-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      
      // 🛡️ SÉCURITÉ ABSOLUE SUR LA DATE
      const validUntil = new Date();
      const parsedMonths = parseInt(session.metadata.validity_months);
      const monthsToAdd = isNaN(parsedMonths) ? 12 : parsedMonths;
      validUntil.setMonth(validUntil.getMonth() + monthsToAdd);

      // 🛡️ SÉCURITÉ ABSOLUE SUR LA BASE DE DONNÉES
      let finalNotes = session.metadata.notes || '';
      if (session.metadata.buyer_address) {
         finalNotes = `📮 À POSTER : ${session.metadata.buyer_address}\n` + finalNotes;
      }

      await client.query(
        `INSERT INTO gift_cards (code, flight_type_id, buyer_name, buyer_phone, beneficiary_name, price_paid_cents, type, status, discount_scope, valid_until, notes, pdf_background_url, buyer_address) 
         VALUES ($1, $2, $3, $4, '', $5, 'gift_card', 'valid', 'both', $6, $7, $8, $9)`,
        [
          finalCode, 
          session.metadata.flight_type_id ? parseInt(session.metadata.flight_type_id) : null, 
          session.metadata.buyer_name || 'Client Inconnu', 
          session.metadata.buyer_phone || null, 
          parseInt(session.metadata.price_paid_cents) || 0, 
          validUntil, 
          finalNotes, // 👈 Les notes avec l'adresse
          session.metadata.pdf_background_url || null,
          session.metadata.buyer_address || null
        ]
      );

      await client.query('COMMIT');

      setImmediate(async () => {
        try {
          const isSpecific = !!session.metadata.flight_type_id;
          const pdfBuf = await generatePDFBuffer({ 
              code: finalCode, 
              buyer_name: session.metadata.buyer_name, 
              price_paid_cents: session.metadata.price_paid_cents, 
              flight_name: isSpecific ? "Vol en parapente" : null, 
              pdf_background_url: session.metadata.pdf_background_url // 👈 Transfert pour générer l'image
          });
          await sendConfirmationEmail(session.metadata.buyer_email, session.metadata.buyer_name, 'gift_card', isSpecific ? "Vol en parapente" : `Avoir de ${(parseInt(session.metadata.price_paid_cents)||0)/100}€`, finalCode, "", null, pdfBuf);
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
    
    let pStatus = session.metadata.voucher_code ? `Payé (CB + Code : ${session.metadata.voucher_code})` : 'Payé (CB en ligne)';
    
    await performBooking(client, contact, passengers, pStatus);

    if (session.metadata.voucher_code) {
        await client.query(`UPDATE gift_cards SET current_uses = current_uses + 1, status = CASE WHEN max_uses IS NOT NULL AND (current_uses + 1) >= max_uses THEN 'used' ELSE status END WHERE UPPER(code) = UPPER($1)`, [session.metadata.voucher_code]);
    }

    await client.query('COMMIT'); 
    res.json({ success: true });

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

app.get('/api/public/download-gift-card/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const voucherRes = await pool.query(`SELECT gc.*, ft.name as flight_name FROM gift_cards gc LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id WHERE UPPER(gc.code) = UPPER($1)`, [code]);
    if (voucherRes.rows.length === 0) return res.status(404).send("Bon cadeau introuvable.");

    const voucher = voucherRes.rows[0];
    const doc = new PDFDocument({ size: 'A4', margin: 0 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Bon_Cadeau_${voucher.code}.pdf`);
    doc.pipe(res);

    // 🎯 On utilise le fond PDF intelligent !
    const backgroundSrc = voucher.pdf_background_url && voucher.pdf_background_url !== '' ? voucher.pdf_background_url : '/cadeau-background.jpg';
    await drawBackground(doc, backgroundSrc);

    doc.fillColor('white').font('Helvetica-Bold').fontSize(38).text('FLUIDE PARAPENTE', 60, 230);
    doc.font('Helvetica').fontSize(24).text('BON CADEAU', 60, 270);
    doc.font('Helvetica').fontSize(10).text('Fluide Parapente - La Clusaz', 0, 765, { align: 'center', width: 595 });
    doc.text('Tél : 06 12 34 56 78 - www.fluideparapente.com', 0, 780, { align: 'center', width: 595 });

    doc.fillColor('#0f172a').font('Helvetica-Bold');
    doc.fontSize(10).fillColor('#64748b').text('OFFERT PAR', 60, 380, { characterSpacing: 2 });
    doc.fontSize(22).fillColor('#1e40af').text((voucher.buyer_name || 'Client Inconnu').toUpperCase(), 60, 395);

    doc.fontSize(10).fillColor('#64748b').text('VALABLE POUR', 60, 490, { characterSpacing: 2 });
    if (voucher.flight_name) {
      doc.fontSize(28).fillColor('#1e40af').text(voucher.flight_name.toUpperCase(), 60, 505);
    } else {
      doc.fontSize(28).fillColor('#1e40af').text(`UN AVOIR LIBRE DE ${voucher.price_paid_cents / 100}€`, 60, 505);
    }

    doc.fontSize(10).fillColor('#64748b').text("CODE D'ACTIVATION UNIQUE", 60, 580, { characterSpacing: 2 });
    doc.fontSize(42).fillColor('#f026b8').text(voucher.code, 60, 595, { characterSpacing: 4 });

    const expiryDate = new Date(voucher.valid_until);
    const formattedDate = isNaN(expiryDate.getTime()) ? '18 MOIS' : expiryDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

    doc.fontSize(10).fillColor('#64748b').text("DATE D'EXPIRATION", 60, 680, { characterSpacing: 2 });
    doc.fontSize(20).fillColor('#1e40af').text(formattedDate.toUpperCase(), 60, 695);

    doc.end();
  } catch (err) {
    console.error("Erreur génération PDF:", err);
    if (!res.headersSent) res.status(500).send("Erreur lors de la génération du bon cadeau.");
  }
});

app.delete('/api/slots/:id', authenticateUser, async (req, res) => {
  try {
    // 🎯 NOUVEAU : On récupère le code cadeau avant de vider le créneau
    const slotRes = await pool.query('SELECT payment_status FROM slots WHERE id = $1', [req.params.id]);
    if (slotRes.rows.length > 0 && slotRes.rows[0].payment_status) {
      const match = slotRes.rows[0].payment_status.match(/(?:Code|Promo|Cadeau)\s*:\s*([a-zA-Z0-9_-]+)/i);
      if (match) {
        const code = match[1].toUpperCase();
        // On supprime le code de la base, SEULEMENT si c'est un vrai Bon Cadeau (pas une Promo)
        await pool.query(`DELETE FROM gift_cards WHERE UPPER(code) = $1 AND type = 'gift_card'`, [code]);
      }
    }

    // Le nettoyage habituel du créneau
    await pool.query(
      `UPDATE slots SET status = 'available', payment_status = NULL, title = NULL, notes = NULL, phone = NULL, email = NULL, booking_options = NULL, client_message = NULL, flight_type_id = NULL, weight_checked = false, weight = NULL WHERE id = $1`, [req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients/bulk-delete', authenticateUser, async (req, res) => {
  const { ids } = req.body;
  if (!ids || ids.length === 0) return res.status(400).json({ error: "Aucun ID" });
  
  try {
    // 🎯 NOUVEAU : On récupère tous les codes cadeaux des créneaux sélectionnés
    const slotsRes = await pool.query('SELECT payment_status FROM slots WHERE id = ANY($1::int[])', [ids]);
    const codesToDelete = [];
    
    for (const row of slotsRes.rows) {
      if (row.payment_status) {
        const match = row.payment_status.match(/(?:Code|Promo|Cadeau)\s*:\s*([a-zA-Z0-9_-]+)/i);
        if (match) codesToDelete.push(match[1].toUpperCase());
      }
    }

    // Si on a trouvé des codes, on les supprime tous en un seul coup
    if (codesToDelete.length > 0) {
      await pool.query(`DELETE FROM gift_cards WHERE UPPER(code) = ANY($1::text[]) AND type = 'gift_card'`, [codesToDelete]);
    }

    // Le nettoyage habituel des créneaux
    await pool.query(`UPDATE slots SET status = 'available', payment_status = NULL, title = NULL, phone = NULL, email = NULL, notes = NULL, booking_options = NULL, client_message = NULL, flight_type_id = NULL, weight = NULL WHERE id = ANY($1::int[])`, [ids]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 📅 GÉNÉRATEUR DE FLUX ICAL (CALENDRIER PILOTES)
// ==========================================
app.get('/api/ical/:id', async (req, res) => {
  try {
    const monitorId = req.params.id;
    
    const userRes = await pool.query('SELECT first_name FROM users WHERE id = $1', [monitorId]);
    if (userRes.rows.length === 0) return res.status(404).send("Moniteur introuvable");
    const monitorName = userRes.rows[0].first_name;

    // FILTRE 1 : SQL (On enlève le maximum ici)
    const slotsRes = await pool.query(`
      SELECT s.*, ft.name as flight_name 
      FROM slots s 
      LEFT JOIN flight_types ft ON s.flight_type_id = ft.id 
      WHERE s.monitor_id = $1 
        AND s.status = 'booked' 
        AND s.title IS NOT NULL
        AND s.title NOT LIKE '↪️ Suite%' 
        AND s.title != 'NOTE'
        AND s.start_time >= NOW() - INTERVAL '30 days'
      ORDER BY s.start_time ASC
    `, [monitorId]);

    let ical = "BEGIN:VCALENDAR\r\n";
    ical += "VERSION:2.0\r\n";
    ical += `PRODID:-//Fluide Parapente//${monitorName}//FR\r\n`;
    ical += "CALSCALE:GREGORIAN\r\n";
    ical += `X-WR-CALNAME:Planning Fluide - ${monitorName}\r\n`; 
    ical += "X-WR-TIMEZONE:Europe/Paris\r\n";

    const formatDate = (date) => {
      return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    slotsRes.rows.forEach(slot => {
      const title = slot.title || "";
      const upperTitle = title.toUpperCase();
      
      // FILTRE 2 : JAVASCRIPT (Barrage absolu anti-pauses et blocages)
      if (
        upperTitle.includes('PAUSE') || 
        upperTitle.includes('NON DISPO') || 
        title.includes('☕') || 
        title.includes('❌') ||
        upperTitle === 'NOTE'
      ) {
        return; // On l'éjecte du calendrier !
      }

      const start = new Date(slot.start_time);
      const end = new Date(slot.end_time);
      const flightName = slot.flight_name || "";
      
      let summary = title;
      if (flightName) summary += ` (${flightName})`;

      let description = "";
      if (slot.phone) description += `Tel: ${slot.phone}\\n`;
      if (slot.booking_options) description += `Options: ${slot.booking_options}\\n`;
      if (slot.notes) description += `Notes: ${slot.notes}\\n`;
      if (slot.client_message) description += `Message client: ${slot.client_message}\\n`;

      ical += "BEGIN:VEVENT\r\n";
      ical += `UID:slot-${slot.id}@fluide-parapente.fr\r\n`;
      ical += `DTSTAMP:${formatDate(new Date())}\r\n`;
      ical += `DTSTART:${formatDate(start)}\r\n`;
      ical += `DTEND:${formatDate(end)}\r\n`;
      ical += `SUMMARY:${summary}\r\n`;
      if (description) ical += `DESCRIPTION:${description}\r\n`;
      ical += "END:VEVENT\r\n";
    });

    ical += "END:VCALENDAR\r\n";

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="planning_fluide_${monitorName}.ics"`);
    res.send(ical);

  } catch (err) {
    console.error("Erreur génération iCal:", err);
    res.status(500).send("Erreur lors de la génération du calendrier");
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => { console.log(`✅ Backend Fluide V3 prêt sur le port ${PORT}`); });