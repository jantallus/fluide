// tests/routes/giftCards.test.js
// Tests d'intégration des routes gift cards (templates, codes, vérification).

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

// ── Setup ──────────────────────────────────────────────────────────────────────

const request  = require('supertest');
const jwt      = require('jsonwebtoken');
const { pool } = require('../../db');

let app;
beforeAll(() => { app = require('../../app'); });
beforeEach(() => { jest.clearAllMocks(); });

const JWT_SECRET = process.env.JWT_SECRET;
const adminToken = () => jwt.sign({ id: 1, role: 'admin', email: 'admin@test.com' }, JWT_SECRET, { expiresIn: '1h' });

// ── GET /api/gift-card-templates ───────────────────────────────────────────────

describe('GET /api/gift-card-templates', () => {
  it('retourne 200 sans auth (route publique)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, title: 'Vol Découverte', is_published: true }] });
    const res = await request(app).get('/api/gift-card-templates');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('filtre les publiés avec ?publicOnly=true', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, title: 'Vol Découverte', is_published: true }] });
    const res = await request(app).get('/api/gift-card-templates?publicOnly=true');
    expect(res.status).toBe(200);
    // Vérifie que la requête inclut le filtre is_published
    const sqlCall = pool.query.mock.calls[0][0];
    expect(sqlCall).toContain('is_published = true');
  });
});

// ── POST /api/gift-card-templates ─────────────────────────────────────────────

describe('POST /api/gift-card-templates', () => {
  it('retourne 401 sans token', async () => {
    const res = await request(app).post('/api/gift-card-templates').send({ title: 'Test' });
    expect(res.status).toBe(401);
  });

  it('crée un template et retourne la ligne insérée', async () => {
    const template = { id: 5, title: 'Vol Acrobatique', price_cents: 12000, validity_months: 12 };
    pool.query.mockResolvedValueOnce({ rows: [template] });

    const res = await request(app)
      .post('/api/gift-card-templates')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ title: 'Vol Acrobatique', price_cents: 12000 });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Vol Acrobatique');
  });
});

// ── DELETE /api/gift-card-templates/:id ────────────────────────────────────────

describe('DELETE /api/gift-card-templates/:id', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).delete('/api/gift-card-templates/1')).status).toBe(401);
  });

  it('supprime le template et retourne success', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .delete('/api/gift-card-templates/1')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── GET /api/gift-cards ───────────────────────────────────────────────────────

describe('GET /api/gift-cards', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).get('/api/gift-cards')).status).toBe(401);
  });

  it('retourne 200 avec la liste des codes', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, code: 'FLUIDE-XYZ', status: 'valid' }] });
    const res = await request(app)
      .get('/api/gift-cards')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body[0].code).toBe('FLUIDE-XYZ');
  });
});

// ── POST /api/gift-cards ──────────────────────────────────────────────────────

describe('POST /api/gift-cards', () => {
  const validBody = {
    type: 'gift_card',
    price_paid_cents: 9500,
  };

  it('retourne 401 sans token', async () => {
    const res = await request(app).post('/api/gift-cards').send(validBody);
    expect(res.status).toBe(401);
  });

  it('retourne 400 si Zod invalide (type inconnu)', async () => {
    const res = await request(app)
      .post('/api/gift-cards')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ type: 'super_admin' }); // valeur hors enum ['gift_card','promo']
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Données invalides/);
  });

  it('transforme custom_code en majuscules et remplace les espaces par -', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, code: 'NOEL-2024', status: 'valid' }] });

    await request(app)
      .post('/api/gift-cards')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ...validBody, custom_code: 'noel 2024' });

    // Vérifie que le code inséré est bien normalisé
    const insertCall = pool.query.mock.calls.find(c => c[0].includes('INSERT INTO gift_cards'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1][0]).toBe('NOEL-2024');
  });

  it('retourne 400 si le code personnalisé est déjà pris (contrainte unique DB)', async () => {
    pool.query.mockRejectedValueOnce({ code: '23505' });

    const res = await request(app)
      .post('/api/gift-cards')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ...validBody, custom_code: 'DOUBLON' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/existe déjà/);
  });
});

// ── PATCH /api/gift-cards/:id/status ─────────────────────────────────────────

describe('PATCH /api/gift-cards/:id/status', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).patch('/api/gift-cards/1/status').send({ status: 'used' })).status).toBe(401);
  });

  it('met à jour le statut du bon', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch('/api/gift-cards/1/status')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'used' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── GET /api/gift-cards/check/:code ──────────────────────────────────────────

describe('GET /api/gift-cards/check/:code', () => {
  it('retourne 404 si le code est invalide ou utilisé', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/gift-cards/check/CODE-INVALIDE');
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/invalide/i);
  });

  it('retourne 200 et les infos du bon pour un code valide', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 3, code: 'FLUIDE-TEST', status: 'valid', price_paid_cents: 9500, flight_name: 'Découverte' }]
    });

    const res = await request(app).get('/api/gift-cards/check/fluide-test');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('FLUIDE-TEST');
    expect(res.body.status).toBe('valid');
  });

  it('est insensible à la casse du code', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 3, code: 'FLUIDE-TEST', status: 'valid' }] });
    const res = await request(app).get('/api/gift-cards/check/fluide-TEST');
    expect(res.status).toBe(200);
    // Vérifie que UPPER() est utilisé dans la requête SQL
    const sqlCall = pool.query.mock.calls[0][0];
    expect(sqlCall).toContain('UPPER(gc.code) = UPPER($1)');
  });
});
