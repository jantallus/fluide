require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { runMigrations } = require('./migrate');

const app = express();
process.env.TZ = 'Europe/Paris';
console.log('🚀 Démarrage du serveur Fluide...');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL : JWT_SECRET non défini dans .env — le serveur ne peut pas démarrer.');
  process.exit(1);
}

// Configuration CORS
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      process.env.TAILSCALE_URL || null,
      'https://fluide-frontend-production.up.railway.app',
      process.env.FRONTEND_URL,
      process.env.WORDPRESS_URL || null,
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`🛑 CORS bloqué pour l'origine : ${origin}`);
      callback(new Error('Accès CORS non autorisé'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());
app.use(cookieParser());

// Routes
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/users'));
app.use('/', require('./routes/flights'));
app.use('/', require('./routes/planning'));
app.use('/', require('./routes/giftCards'));
app.use('/', require('./routes/admin'));
app.use('/', require('./routes/public'));

// Démarrage
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
