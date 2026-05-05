// tests/routes/auth.test.js
// Tests d'intégration des routes d'authentification (login, logout).

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('stripe', () => () => ({
  checkout: { sessions: { create: jest.fn() } },
}));
jest.mock('../../services/email', () => ({
  sendConfirmationEmail:      jest.fn(),
  sendAdminNotificationEmail: jest.fn(),
  notifyGoogleCalendar:       jest.fn(),
}));
jest.mock('../../services/sentry', () => ({
  initSentry:            () => {},
  sentryErrorMiddleware: (err, req, res, next) => next(err),
}));
jest.mock('../../services/googleSync', () => ({ googleSyncCache: new Map() }));
jest.mock('../../services/ical',       () => ({ generateICalFeed: jest.fn() }));
jest.mock('../../services/pdf',        () => ({
  generatePDFBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')),
  drawBackground:    jest.fn(),
}));
jest.mock('../../routes/webhook', () => {
  const express = require('express');
  return express.Router();
});
// Désactive le rate-limiter pour éviter les faux positifs sur les tests multiples
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
// Mock bcrypt pour contrôler le résultat de compare sans hachage réel
jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash:    jest.fn().mockResolvedValue('$hashed'),
}));

// ── Setup ──────────────────────────────────────────────────────────────────────

const request  = require('supertest');
const bcrypt   = require('bcrypt');
const { pool } = require('../../db');

let app;
beforeAll(() => { app = require('../../app'); });
beforeEach(() => { jest.resetAllMocks(); });

const DB_USER = { id: 1, email: 'admin@test.com', first_name: 'Admin', role: 'admin', password_hash: '$hashed' };

// ── POST /api/login ────────────────────────────────────────────────────────────

describe('POST /api/login', () => {
  it('retourne 401 si l\'email est inconnu', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/login')
      .send({ email: 'inconnu@test.com', password: 'motdepasse' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Identifiants incorrects/);
  });

  it('retourne 401 si le mot de passe est incorrect', async () => {
    pool.query.mockResolvedValueOnce({ rows: [DB_USER] });
    bcrypt.compare.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/api/login')
      .send({ email: 'admin@test.com', password: 'mauvais' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Identifiants incorrects/);
  });

  it('retourne 200 avec token et user si les identifiants sont corrects', async () => {
    pool.query.mockResolvedValueOnce({ rows: [DB_USER] });
    bcrypt.compare.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/api/login')
      .send({ email: 'admin@test.com', password: 'correct' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toMatchObject({ id: 1, email: 'admin@test.com', role: 'admin' });
  });

  it('pose un cookie HttpOnly auth_token', async () => {
    pool.query.mockResolvedValueOnce({ rows: [DB_USER] });
    bcrypt.compare.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/api/login')
      .send({ email: 'admin@test.com', password: 'correct' });

    const cookies = res.headers['set-cookie'] || [];
    const authCookie = cookies.find(c => c.startsWith('auth_token='));
    expect(authCookie).toBeDefined();
    expect(authCookie).toMatch(/HttpOnly/i);
  });

  it('ne renvoie pas le password_hash dans la réponse', async () => {
    pool.query.mockResolvedValueOnce({ rows: [DB_USER] });
    bcrypt.compare.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/api/login')
      .send({ email: 'admin@test.com', password: 'correct' });

    expect(JSON.stringify(res.body)).not.toContain('password_hash');
    expect(JSON.stringify(res.body)).not.toContain('$hashed');
  });
});

// ── POST /api/logout ───────────────────────────────────────────────────────────

describe('POST /api/logout', () => {
  it('retourne 200 et efface le cookie auth_token', async () => {
    const res = await request(app).post('/api/logout');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Le cookie doit être expiré (Max-Age=0 ou expires dans le passé)
    const cookies = res.headers['set-cookie'] || [];
    const authCookie = cookies.find(c => c.startsWith('auth_token='));
    expect(authCookie).toBeDefined();
    expect(authCookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it('fonctionne sans token (pas d\'auth requise)', async () => {
    const res = await request(app).post('/api/logout');
    expect(res.status).toBe(200);
  });
});
