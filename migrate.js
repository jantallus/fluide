// migrate.js — Système de migrations SQL versionnées
// Chaque migration n'est exécutée QU'UNE SEULE FOIS, même après plusieurs redémarrages.

const db = require('./db');

const migrations = [
  {
    name: '001_gift_card_custom_lines',
    sql: `
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS custom_line_1 VARCHAR(255);
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS custom_line_2 VARCHAR(255);
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS custom_line_3 VARCHAR(255);
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS custom_line_1 VARCHAR(255);
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS custom_line_2 VARCHAR(255);
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS custom_line_3 VARCHAR(255);
      ALTER TABLE gift_card_templates ALTER COLUMN custom_line_1 TYPE VARCHAR(255);
      ALTER TABLE gift_card_templates ALTER COLUMN custom_line_2 TYPE VARCHAR(255);
      ALTER TABLE gift_card_templates ALTER COLUMN custom_line_3 TYPE VARCHAR(255);
      ALTER TABLE gift_cards ALTER COLUMN custom_line_1 TYPE VARCHAR(255);
      ALTER TABLE gift_cards ALTER COLUMN custom_line_2 TYPE VARCHAR(255);
      ALTER TABLE gift_cards ALTER COLUMN custom_line_3 TYPE VARCHAR(255);
    `
  },
  {
    name: '002_gift_cards_buyer_phone',
    sql: `ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS buyer_phone VARCHAR(50);`
  },
  {
    name: '003_pdf_background_url',
    sql: `
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS pdf_background_url VARCHAR(500);
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS pdf_background_url VARCHAR(500);
    `
  },
  {
    name: '004_gift_cards_partner_billing',
    sql: `
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS is_partner BOOLEAN DEFAULT false;
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS partner_amount_cents INTEGER;
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS partner_billing_type VARCHAR(50) DEFAULT 'fixed';
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS buyer_address TEXT;
    `
  },
  {
    name: '005_gift_card_templates_popup',
    sql: `
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS popup_content TEXT;
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS show_popup BOOLEAN DEFAULT false;
    `
  },
  {
    name: '006_flight_types_popup',
    sql: `
      ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS popup_content TEXT;
      ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS show_popup BOOLEAN DEFAULT false;
    `
  },
  {
    name: '007_monitor_availabilities',
    sql: `
      CREATE TABLE IF NOT EXISTS monitor_availabilities (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        daily_start_time TIME NOT NULL,
        daily_end_time TIME NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_monitor_availabilities_user_id ON monitor_availabilities(user_id);
    `
  },
  {
    name: '008_processed_stripe_sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS processed_stripe_sessions (
        session_id VARCHAR(255) PRIMARY KEY,
        processed_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: '009_slots_payment_data',
    sql: `ALTER TABLE slots ADD COLUMN IF NOT EXISTS payment_data JSONB;`
  },
  {
    name: '010_slots_drop_payment_status',
    sql: `ALTER TABLE slots DROP COLUMN IF EXISTS payment_status;`
  },
  {
    name: '011_stripe_payments',
    sql: `
      CREATE TABLE IF NOT EXISTS stripe_payments (
        session_id   TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        result_code  TEXT,
        processed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `
  },
  {
    name: '012_users_google_sync_enabled',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sync_enabled BOOLEAN NOT NULL DEFAULT false;`
  },
  {
    name: '013_flight_types_description',
    sql: `ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS description TEXT;`
  },
];

async function runMigrations() {
  // Création de la table de suivi si elle n'existe pas
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id     SERIAL PRIMARY KEY,
      name   VARCHAR(255) UNIQUE NOT NULL,
      run_at TIMESTAMP DEFAULT NOW()
    )
  `);

  let applied = 0;
  for (const migration of migrations) {
    const { rows } = await db.query(
      'SELECT id FROM _migrations WHERE name = $1',
      [migration.name]
    );

    if (rows.length === 0) {
      console.log(`▶  Migration : ${migration.name}`);
      await db.query(migration.sql);
      await db.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name]);
      console.log(`✅ Migration appliquée : ${migration.name}`);
      applied++;
    }
  }

  if (applied === 0) {
    console.log('✅ Base de données à jour — aucune migration à appliquer.');
  } else {
    console.log(`✅ ${applied} migration(s) appliquée(s) avec succès.`);
  }
}

module.exports = { runMigrations };
