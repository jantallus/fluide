// db.js — Pool de connexion unique partagé dans toute l'application
const { Pool, types } = require('pg');
require('dotenv').config();

// Force les colonnes DATE (OID 1082) à rester des strings "YYYY-MM-DD"
// plutôt que d'être converties en objets Date JavaScript (source de bugs timezone).
types.setTypeParser(1082, val => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Erreur de connexion à la base de données PostgreSQL :', err.stack);
  } else {
    console.log('✅ Connecté à la base de données avec succès !');
    release();
  }
});


pool.on('error', (err) => {
  console.error('Erreur inattendue du pool de connexion:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool, // Exporté pour les cas nécessitant l'objet pool directement
};
