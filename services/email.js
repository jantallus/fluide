const db = require('../db');
const { pool } = db;

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
  const webhookUrl = process.env.GOOGLE_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbwRlzxV3bb1vIAnDiY0qz4YJGzPDwHu9qoABxaf5Q89lljHpf7rCP9hclWdoFF44L2j/exec";
  
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


module.exports = { sendConfirmationEmail, sendConfirmationSMS, sendAdminNotificationEmail, notifyGoogleCalendar };
