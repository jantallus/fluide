// tests/services/booking.test.js
// Teste la logique d'allocation de slots de performBooking sans toucher la DB.

jest.mock('../../services/email', () => ({
  notifyGoogleCalendar: jest.fn(),
}));

const { performBooking } = require('../../services/booking');

// ── Helpers pour construire des slots de test ─────────────────────────────────

function makeSlot(id, monitorId, startHour, startMin = 0) {
  const start = new Date(`2026-06-15T${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00.000Z`);
  const end   = new Date(start.getTime() + 15 * 60 * 1000); // +15 min
  return {
    id,
    monitor_id: monitorId,
    status: 'available',
    start_time: start.toISOString(),
    end_time:   end.toISOString(),
  };
}

// Convertit une heure UTC en HH:MM Europe/Paris (UTC+2 en été)
function parisTime(utcHour, utcMin = 0) {
  const h = utcHour + 2; // UTC+2 en été
  return `${String(h).padStart(2, '0')}:${String(utcMin).padStart(2, '0')}`;
}

// ── Mock du client DB ─────────────────────────────────────────────────────────

function makeMockClient(overrides = {}) {
  return {
    query: jest.fn().mockImplementation(async (sql) => {
      // SELECT flight_types
      if (sql.includes('flight_types')) return overrides.flightType ?? { rows: [{ id: 1, duration_minutes: 15 }] };
      // SELECT slots
      if (sql.includes('FROM slots')) return overrides.slots ?? { rows: [] };
      // SELECT complements
      if (sql.includes('complements')) return { rows: [] };
      // UPDATE slots
      if (sql.includes('UPDATE slots')) return { rows: [] };
      // SELECT site_settings (google sync)
      if (sql.includes('site_settings')) return { rows: [{ value: 'false' }] };
      return { rows: [] };
    }),
  };
}

const contact = {
  firstName: 'Jean',
  lastName:  'Dupont',
  email:     'jean@test.com',
  phone:     '0612345678',
  notes:     '',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('performBooking', () => {

  it('réserve un slot unique pour un vol de 15 min', async () => {
    // Slot à 10h UTC → 12h Paris
    const slot = makeSlot(1, 42, 8, 0); // 08h UTC = 10h Paris
    const client = makeMockClient({ slots: { rows: [slot] } });

    const passenger = {
      firstName: 'Marie',
      flightId:  1,
      date:      '2026-06-15',
      time:      parisTime(8), // '10:00' Paris
    };

    await performBooking(client, contact, [passenger]);

    // Doit avoir fait un UPDATE slots
    const updateCall = client.query.mock.calls.find(c => c[0].includes('UPDATE slots'));
    expect(updateCall).toBeDefined();
    // Le titre du slot doit contenir le nom du passager
    expect(updateCall[1][0]).toBe('Marie DUPONT');
  });

  it('réserve 2 slots consécutifs pour un vol de 30 min', async () => {
    const slot1 = makeSlot(10, 99, 8, 0);  // 10h00 Paris
    const slot2 = makeSlot(11, 99, 8, 15); // 10h15 Paris

    const client = makeMockClient({
      flightType: { rows: [{ id: 2, duration_minutes: 30 }] },
      slots:      { rows: [slot1, slot2] },
    });

    const passenger = {
      firstName: 'Luc',
      flightId:  2,
      date:      '2026-06-15',
      time:      parisTime(8),
    };

    await performBooking(client, contact, [passenger]);

    const updateCalls = client.query.mock.calls.filter(c => c[0].includes('UPDATE slots'));
    expect(updateCalls).toHaveLength(2);
    // Premier slot : nom passager
    expect(updateCalls[0][1][0]).toBe('Luc DUPONT');
    // Deuxième slot : préfixé "↪️ Suite"
    expect(updateCalls[1][1][0]).toContain('↪️ Suite');
  });

  it('lance une erreur si aucun moniteur disponible', async () => {
    const client = makeMockClient({ slots: { rows: [] } });

    const passenger = {
      firstName: 'Sophie',
      flightId:  1,
      date:      '2026-06-15',
      time:      '10:00',
    };

    await expect(performBooking(client, contact, [passenger]))
      .rejects.toThrow('Plus de moniteur dispo');
  });

  it('lance une erreur si l\'heure demandée n\'est pas disponible', async () => {
    // Slot disponible à 10h00, passager demande 14h00
    const slot = makeSlot(5, 7, 8, 0); // 10h Paris
    const client = makeMockClient({ slots: { rows: [slot] } });

    const passenger = {
      firstName: 'Alice',
      flightId:  1,
      date:      '2026-06-15',
      time:      '14:00', // heure non disponible
    };

    await expect(performBooking(client, contact, [passenger]))
      .rejects.toThrow('Plus de moniteur dispo');
  });

  it('enregistre le billing_name et le group_id sur le slot', async () => {
    const slot = makeSlot(20, 3, 8, 0);
    const client = makeMockClient({ slots: { rows: [slot] } });

    const passenger = { firstName: 'Tom', flightId: 1, date: '2026-06-15', time: parisTime(8) };
    const billingInfo = { billing_name: 'MARTIN Paul', billing_email: 'paul@test.com', group_id: 'uuid-test' };

    await performBooking(client, contact, [passenger], null, billingInfo);

    const updateCall = client.query.mock.calls.find(c => c[0].includes('UPDATE slots'));
    expect(updateCall[1][9]).toBe('MARTIN Paul');  // $10 = billing_name
    expect(updateCall[1][10]).toBe('paul@test.com'); // $11 = billing_email
    expect(updateCall[1][11]).toBe('uuid-test');     // $12 = group_id
  });

  it('ne plante pas si les slots ne sont pas consécutifs (gap > 1 min)', async () => {
    // Vol 30 min mais les 2 slots ont un gap de 5 min → doit échouer
    const slot1 = makeSlot(30, 5, 8, 0);   // 10h00
    const slot2 = makeSlot(31, 5, 8, 20);  // 10h20 (gap de 5 min au lieu de 0)

    const client = makeMockClient({
      flightType: { rows: [{ id: 2, duration_minutes: 30 }] },
      slots:      { rows: [slot1, slot2] },
    });

    const passenger = { firstName: 'Eva', flightId: 2, date: '2026-06-15', time: parisTime(8) };

    await expect(performBooking(client, contact, [passenger]))
      .rejects.toThrow('Plus de moniteur dispo');
  });
});
