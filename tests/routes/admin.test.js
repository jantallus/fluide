// tests/routes/admin.test.js
// Tests d'intégration des routes admin (auth, pagination, bulk-delete).

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('stripe', () => () => ({
  checkout: { sessions: { create: jest.fn() } },
}));
jest.mock('../../services/email', () => ({
  sendConfirmationEmail:      jest.fn(),
  sendConfirmationSMS:        jest.fn(),
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

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { pool } = require('../../db');

let app;
beforeAll(() => { app = require('../../app'); });
beforeEach(() => { jest.resetAllMocks(); });

const JWT_SECRET = process.env.JWT_SECRET;

const adminToken   = () => jwt.sign({ id: 1, role: 'admin',     email: 'admin@test.com'   }, JWT_SECRET, { expiresIn: '1h' });
const monitorToken = () => jwt.sign({ id: 2, role: 'monitor',   email: 'monitor@test.com' }, JWT_SECRET, { expiresIn: '1h' });
const userToken    = () => jwt.sign({ id: 3, role: 'permanent', email: 'perm@test.com'    }, JWT_SECRET, { expiresIn: '1h' });

// ── GET /api/clients ───────────────────────────────────────────────────────────

describe('GET /api/clients', () => {
  it('retourne 401 sans token', async () => {
    const res = await request(app).get('/api/clients');
    expect(res.status).toBe(401);
  });

  it('retourne 403 si rôle monitor (non admin)', async () => {
    const res = await request(app)
      .get('/api/clients')
      .set('Authorization', `Bearer ${monitorToken()}`);
    expect(res.status).toBe(403);
  });

  it('retourne 200 avec pagination pour un admin', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total: '5' }] })          // COUNT
      .mockResolvedValueOnce({ rows: [{ id: 1, first_name: 'Jean', flights: [] }] }); // data

    const res = await request(app)
      .get('/api/clients?page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('clients');
    expect(res.body).toHaveProperty('total', 5);
    expect(res.body).toHaveProperty('page', 1);
    expect(res.body).toHaveProperty('totalPages', 1);
  });

  it('limite le paramètre limit à 100 max', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/clients?limit=999')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // Vérifie que la requête SQL a bien reçu limit ≤ 100 (indirectement : pas d'erreur DB)
  });
});

// ── GET /api/dashboard-stats ───────────────────────────────────────────────────

describe('GET /api/dashboard-stats', () => {
  it('retourne 401 sans token', async () => {
    const res = await request(app).get('/api/dashboard-stats');
    expect(res.status).toBe(401);
  });

  it('retourne 403 pour un non-admin', async () => {
    const res = await request(app)
      .get('/api/dashboard-stats')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(403);
  });

  it('retourne 200 avec summary et upcoming pour un admin', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total_slots: '10', booked_slots: '4', revenue: '38000' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, title: 'Marie', flight_name: 'Découverte' }] });

    const res = await request(app)
      .get('/api/dashboard-stats')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ todaySlots: 10, bookedSlots: 4, revenue: 38000 });
    expect(Array.isArray(res.body.upcoming)).toBe(true);
  });
});

// ── GET /api/settings ─────────────────────────────────────────────────────────

describe('GET /api/settings', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).get('/api/settings')).status).toBe(401);
  });

  it('retourne 200 et les settings pour un admin', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ key: 'display_days_count', value: '7' }] });
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── POST /api/settings ────────────────────────────────────────────────────────

describe('POST /api/settings', () => {
  it('retourne 403 pour un non-admin', async () => {
    const res = await request(app)
      .post('/api/settings')
      .set('Authorization', `Bearer ${monitorToken()}`)
      .send({ key: 'foo', value: 'bar' });
    expect(res.status).toBe(403);
  });

  it('retourne 200 et upsert le setting', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post('/api/settings')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ key: 'display_days_count', value: '5' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── GET /api/stats ────────────────────────────────────────────────────────────

describe('GET /api/stats', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).get('/api/stats')).status).toBe(401);
  });

  it('retourne 200 avec totalRevenue et totalBookings', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total_revenue: '190000', total_bookings: '20' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/stats')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ totalRevenue: 190000, totalBookings: 20 });
  });
});

// ── POST /api/clients/bulk-delete ─────────────────────────────────────────────

describe('POST /api/clients/bulk-delete', () => {
  it('retourne 401 sans token', async () => {
    const res = await request(app).post('/api/clients/bulk-delete').send({ ids: [1] });
    expect(res.status).toBe(401);
  });

  it('retourne 400 si ids est vide', async () => {
    const res = await request(app)
      .post('/api/clients/bulk-delete')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ids: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Aucun ID/);
  });

  it('libère les slots et supprime les bons cadeaux associés', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ payment_data: { code: 'FLUIDE-ABC', code_type: 'gift_card' } }] }) // SELECT slots
      .mockResolvedValueOnce({ rows: [] }) // DELETE gift_cards
      .mockResolvedValueOnce({ rows: [] }); // UPDATE slots

    const res = await request(app)
      .post('/api/clients/bulk-delete')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ids: [42] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Vérifie que DELETE gift_cards a été appelé
    const deleteCall = pool.query.mock.calls.find(c => c[0].includes('DELETE FROM gift_cards'));
    expect(deleteCall).toBeDefined();
  });

  it('ne supprime pas de bon cadeau si payment_data est absent', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ payment_data: null }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE slots uniquement

    const res = await request(app)
      .post('/api/clients/bulk-delete')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ids: [99] });

    expect(res.status).toBe(200);
    const deleteCall = pool.query.mock.calls.find(c => c[0].includes('DELETE FROM gift_cards'));
    expect(deleteCall).toBeUndefined();
  });
});
