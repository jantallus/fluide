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
    const monRes = await pool.query("SELECT id, first_name FROM users WHERE is_active_monitor = true AND status = 'Actif' AND google_sync_enabled = true");
    const webhookUrl = process.env.GOOGLE_SCRIPT_URL;
    if (!webhookUrl) { isSyncing = false; return; }

    // Le serveur va toquer chez Google silencieusement
    for (const mon of monRes.rows) {
      try {
        const resp = await fetch(`${webhookUrl}?monitorName=${encodeURIComponent(mon.first_name)}`);
        if (!resp.ok) {
          console.warn(`Sync Google ${mon.first_name} : HTTP ${resp.status}`);
          continue;
        }
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          console.warn(`Sync Google ${mon.first_name} : réponse non-JSON (${contentType}) — vérifier le déploiement du Apps Script`);
          continue;
        }
        const slots = await resp.json();
        googleSyncCache.set(mon.id, slots);
      } catch(e) {
        console.error("Erreur sync Google pour", mon.first_name, ":", e.message);
      }
    }
  } catch(e) {
    console.error("Erreur Background Sync:", e);
  } finally {
    isSyncing = false;
  }
}

// ⏱️ Le serveur refait le point toutes les 2 minutes (120 000 millisecondes)
let syncInterval = setInterval(runBackgroundGoogleSync, 120000);
// 🚀 On lance un premier check 5 secondes après le démarrage du serveur
let syncTimeout = setTimeout(runBackgroundGoogleSync, 5000);

/** Arrête proprement les timers (appelé lors du graceful shutdown). */
function stopSync() {
  clearInterval(syncInterval);
  clearTimeout(syncTimeout);
}

module.exports = { googleSyncCache, stopSync };
