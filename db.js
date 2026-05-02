// db.js — Pool de connexion unique partagé dans toute l'application
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Erreur de connexion à la base de données PostgreSQL :', err.stack);
  } else {
    console.log('✅ Connecté à la base de données avec succès !');
    release();
  }
});

// 🛡️ IDEMPOTENCY : Table de suivi des sessions Stripe déjà traitées.
// Garantit qu'un paiement ne peut jamais être traité deux fois,
// même si le serveur redémarre ou tourne sur plusieurs instances.
pool.query(`
  CREATE TABLE IF NOT EXISTS stripe_payments (
    session_id   TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    result_code  TEXT,
    processed_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => {
  console.error('❌ Impossible de créer la table stripe_payments :', err.message);
});

pool.on('error', (err) => {
  console.error('Erreur inattendue du pool de connexion:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool, // Exporté pour les cas nécessitant l'objet pool directement
};
