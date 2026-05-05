require('dotenv').config();
process.env.TZ = 'Europe/Paris';

const { runMigrations } = require('./migrate');

// Vérification des secrets critiques avant tout démarrage
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL : JWT_SECRET non défini dans .env — le serveur ne peut pas démarrer.');
  process.exit(1);
}
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ FATAL : STRIPE_SECRET_KEY non défini dans .env — le serveur ne peut pas démarrer.');
  process.exit(1);
}

// Effet de bord : lance la synchro Google (interval toutes les 2 min)
// Importé ici uniquement, pas dans app.js, pour ne pas polluer les tests.
const { stopSync } = require('./services/googleSync');
const { pool }     = require('./db');

console.log('🚀 Démarrage du serveur Fluide...');

const app = require('./app');
const PORT = process.env.PORT || 3001;

runMigrations()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Backend Fluide prêt sur le port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ Échec des migrations — serveur non démarré :', err.message);
    process.exit(1);
  });

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n⚠️  Signal ${signal} reçu — arrêt propre du serveur...`);
  try {
    stopSync();           // arrête les timers Google Calendar
    await pool.end();     // vide le pool de connexions PostgreSQL
    console.log('✅ Serveur arrêté proprement.');
  } catch (err) {
    console.error('❌ Erreur lors du shutdown :', err.message);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
