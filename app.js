// app.js — Express app sans démarrage serveur ni effets de bord.
// Importé par index.js (prod) et par les tests (supertest).

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { initSentry, sentryErrorMiddleware } = require('./services/sentry');

initSentry();

const app = express();

// Railway (et tout reverse proxy) envoie X-Forwarded-For — on lui fait confiance
app.set('trust proxy', 1);

app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      process.env.TAILSCALE_URL,
      'https://fluide-frontend-production.up.railway.app',
      process.env.FRONTEND_URL,
      process.env.WORDPRESS_URL,
    ].filter(Boolean); // élimine les undefined/null quand une variable d'env n'est pas définie
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Origine refusée : "${origin}" — ajoutez-la à FRONTEND_URL ou WORDPRESS_URL si c'est légitime.`);
      callback(new Error('Accès CORS non autorisé'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ⚠️ Webhook Stripe avant express.json()
app.use('/', require('./routes/webhook'));

app.use(express.json());
app.use(cookieParser());

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/users'));
app.use('/', require('./routes/flights'));
app.use('/', require('./routes/planning'));
app.use('/', require('./routes/giftCards'));
app.use('/', require('./routes/partners'));
app.use('/', require('./routes/admin'));
app.use('/', require('./routes/regularisation'));
app.use('/', require('./routes/public'));

app.use(sentryErrorMiddleware);

// ── Health check (Docker / Railway) ───────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

module.exports = app;
