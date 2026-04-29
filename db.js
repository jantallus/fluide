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

pool.on('error', (err) => {
  console.error('Erreur inattendue du pool de connexion:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool, // Exporté pour les cas nécessitant l'objet pool directement
};
