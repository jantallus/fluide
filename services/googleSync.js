const db = require('../db');
const { pool } = db;

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

module.exports = { googleSyncCache };
