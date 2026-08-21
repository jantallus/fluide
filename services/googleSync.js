const db = require('../db');
const { pool } = db;
const { notifyGoogleCalendar } = require('./email');

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
        const text = await resp.text();
        let slots;
        try { slots = JSON.parse(text); } catch {
          console.warn(`Sync Google ${mon.first_name} : réponse non-JSON — vérifier le déploiement du Apps Script`);
          continue;
        }
        if (!Array.isArray(slots)) continue;
        googleSyncCache.set(mon.id, slots);
        console.log(`✅ Sync Google ${mon.first_name} : ${slots.length} événement(s)`);

        // Recréer les événements Fluide supprimés de Google Calendar
        const bookedRes = await pool.query(
          `SELECT id, title, start_time, end_time, notes, booking_options
           FROM slots
           WHERE monitor_id = $1
             AND status = 'booked'
             AND start_time > NOW()
             AND start_time < NOW() + INTERVAL '90 days'
             AND payment_data->>'google_synced' = 'true'`,
          [mon.id]
        );
        for (const slot of bookedRes.rows) {
          const slotStart = new Date(slot.start_time).getTime();
          const slotEnd   = new Date(slot.end_time).getTime();
          const hasEvent  = slots.some(g => g.start < slotEnd && g.end > slotStart);
          if (!hasEvent) {
            console.log(`🔄 Recréation Google Calendar : ${slot.title} @ ${new Date(slot.start_time).toISOString()}`);
            const desc = [
              slot.booking_options ? `Options: ${slot.booking_options}` : '',
              slot.notes || ''
            ].filter(Boolean).join('\n');
            notifyGoogleCalendar(mon.first_name, slot.title, slot.start_time, slot.end_time, desc);
          }
        }
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

/** Invalide le cache d'un moniteur pour forcer une re-fetch au prochain appel. */
function invalidateCacheForMonitor(monitorId) {
  if (monitorId != null) googleSyncCache.delete(monitorId);
}

/** Arrête proprement les timers (appelé lors du graceful shutdown). */
function stopSync() {
  clearInterval(syncInterval);
  clearTimeout(syncTimeout);
}

module.exports = { googleSyncCache, invalidateCacheForMonitor, stopSync };
