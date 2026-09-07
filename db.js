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

pool.connect(async (err, client, release) => {
  if (err) {
    console.error('❌ Erreur de connexion à la base de données PostgreSQL :', err.stack);
  } else {
    console.log('✅ Connecté à la base de données avec succès !');
    release();
    runStartupMigrations();
  }
});

async function runStartupMigrations() {
  try {
    await pool.query(`ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS tenant VARCHAR(20) NOT NULL DEFAULT 'fluide'`);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM flight_types WHERE tenant = 'aravis'`);
    if (rows[0].n === 0) {
      await pool.query(`
        INSERT INTO flight_types (name, duration_minutes, price_cents, color_code, season, weight_min, weight_max, allow_multi_slots, booking_delay_hours, tenant)
        VALUES
          ('Découverte',  40,  6500, '#3b82f6', 'ALL', 15, 110, false, 1, 'aravis'),
          ('Plaisir',     60,  9000, '#10b981', 'ALL', 20, 110, false, 1, 'aravis'),
          ('Performance', 90, 12500, '#f59e0b', 'ALL', 20, 110, false, 1, 'aravis'),
          ('Prestige',   120, 16700, '#8b5cf6', 'ALL', 20, 110, false, 1, 'aravis')
      `);
      console.log('✅ Prestations Aravis Parapente initialisées');
    }
  } catch (err) {
    console.error('⚠️  Migration startup:', err.message);
  }
}


pool.on('error', (err) => {
  console.error('Erreur inattendue du pool de connexion:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool, // Exporté pour les cas nécessitant l'objet pool directement
};
