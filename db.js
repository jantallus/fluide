// db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Nécessaire pour les connexions externes vers Railway/Heroku
  }
});

// Test de la connexion à la base de données
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Erreur de connexion à la base de données PostgreSQL :', err.stack);
  } else {
    console.log('✅ Connecté à la base de données Railway avec succès !');
    release(); // On libère la connexion pour ne pas bloquer le serveur
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};