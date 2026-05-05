// tests/schemas.test.js
// Vérifie que les schémas Zod acceptent les données valides et rejettent les invalides.

const {
  CheckoutSchema,
  CheckoutGiftCardSchema,
  CreateUserSchema,
  UpdateUserSchema,
  FlightTypeSchema,
  QuickPatchSchema,
} = require('../schemas');

// ── Helpers ──────────────────────────────────────────────────────────────────

const validContact = {
  firstName: 'Jean',
  lastName: 'Dupont',
  email: 'jean.dupont@example.com',
  phone: '0612345678',
};

const validPassenger = {
  firstName: 'Marie',
  flightId: 1,
  date: '2026-06-15',
  time: '10:00',
};

// ── CheckoutSchema ────────────────────────────────────────────────────────────

describe('CheckoutSchema', () => {
  it('accepte une réservation valide avec 1 passager', () => {
    const result = CheckoutSchema.safeParse({
      contact: validContact,
      passengers: [validPassenger],
    });
    expect(result.success).toBe(true);
  });

  it('accepte plusieurs passagers', () => {
    const result = CheckoutSchema.safeParse({
      contact: validContact,
      passengers: [validPassenger, { ...validPassenger, firstName: 'Luc' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepte un code promo optionnel', () => {
    const result = CheckoutSchema.safeParse({
      contact: validContact,
      passengers: [validPassenger],
      voucher_code: 'FLUIDE-ABC123',
    });
    expect(result.success).toBe(true);
  });

  it('rejette si email invalide', () => {
    const result = CheckoutSchema.safeParse({
      contact: { ...validContact, email: 'pas-un-email' },
      passengers: [validPassenger],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toContain('email');
  });

  it('rejette si aucun passager', () => {
    const result = CheckoutSchema.safeParse({
      contact: validContact,
      passengers: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejette si plus de 10 passagers', () => {
    const result = CheckoutSchema.safeParse({
      contact: validContact,
      passengers: Array(11).fill(validPassenger),
    });
    expect(result.success).toBe(false);
  });

  it('rejette si date mal formatée', () => {
    const result = CheckoutSchema.safeParse({
      contact: validContact,
      passengers: [{ ...validPassenger, date: '15/06/2026' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejette si heure mal formatée', () => {
    const result = CheckoutSchema.safeParse({
      contact: validContact,
      passengers: [{ ...validPassenger, time: '10h00' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejette si flightId n\'est pas un entier positif', () => {
    const result = CheckoutSchema.safeParse({
      contact: validContact,
      passengers: [{ ...validPassenger, flightId: -1 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejette si firstName passager est vide', () => {
    const result = CheckoutSchema.safeParse({
      contact: validContact,
      passengers: [{ ...validPassenger, firstName: '' }],
    });
    expect(result.success).toBe(false);
  });
});

// ── CheckoutGiftCardSchema ────────────────────────────────────────────────────

describe('CheckoutGiftCardSchema', () => {
  const validGiftCard = {
    template: { id: 3 },
    buyer: { name: 'Paul Martin', email: 'paul@example.com' },
  };

  it('accepte un achat de bon cadeau valide', () => {
    const result = CheckoutGiftCardSchema.safeParse(validGiftCard);
    expect(result.success).toBe(true);
  });

  it('accepte avec envoi postal', () => {
    const result = CheckoutGiftCardSchema.safeParse({
      ...validGiftCard,
      physicalShipping: { enabled: true, address: '12 rue de la Paix, 75001 Paris' },
    });
    expect(result.success).toBe(true);
  });

  it('rejette si email acheteur invalide', () => {
    const result = CheckoutGiftCardSchema.safeParse({
      ...validGiftCard,
      buyer: { name: 'Paul', email: 'not-an-email' },
    });
    expect(result.success).toBe(false);
  });

  it('rejette si template.id manquant', () => {
    const result = CheckoutGiftCardSchema.safeParse({
      template: {},
      buyer: { name: 'Paul', email: 'paul@example.com' },
    });
    expect(result.success).toBe(false);
  });

  it('rejette si plus de 10 compléments', () => {
    const result = CheckoutGiftCardSchema.safeParse({
      ...validGiftCard,
      selectedComplements: Array(11).fill({ id: 1 }),
    });
    expect(result.success).toBe(false);
  });
});

// ── CreateUserSchema ──────────────────────────────────────────────────────────

describe('CreateUserSchema', () => {
  const validUser = {
    first_name: 'Léo',
    email: 'leo@fluide.fr',
    password: 'motdepasse123',
    role: 'monitor',
  };

  it('accepte un utilisateur valide', () => {
    expect(CreateUserSchema.safeParse(validUser).success).toBe(true);
  });

  it('accepte les 3 rôles valides', () => {
    for (const role of ['admin', 'monitor', 'permanent']) {
      expect(CreateUserSchema.safeParse({ ...validUser, role }).success).toBe(true);
    }
  });

  it('rejette un rôle inconnu', () => {
    const result = CreateUserSchema.safeParse({ ...validUser, role: 'superadmin' });
    expect(result.success).toBe(false);
  });

  it('rejette si mot de passe trop court (< 8 chars)', () => {
    const result = CreateUserSchema.safeParse({ ...validUser, password: '123' });
    expect(result.success).toBe(false);
  });

  it('rejette si email invalide', () => {
    const result = CreateUserSchema.safeParse({ ...validUser, email: 'nope' });
    expect(result.success).toBe(false);
  });
});

// ── QuickPatchSchema ──────────────────────────────────────────────────────────

describe('QuickPatchSchema (strict)', () => {
  it('accepte payment_data seul', () => {
    const result = QuickPatchSchema.safeParse({ payment_data: { cb: 12000 } });
    expect(result.success).toBe(true);
  });

  it('accepte billing_name seul', () => {
    const result = QuickPatchSchema.safeParse({ billing_name: 'DUPONT Jean' });
    expect(result.success).toBe(true);
  });

  it('accepte monitor_id null (désassigner)', () => {
    const result = QuickPatchSchema.safeParse({ monitor_id: null });
    expect(result.success).toBe(true);
  });

  it('rejette un champ inconnu (strict)', () => {
    const result = QuickPatchSchema.safeParse({ champ_pirate: 'valeur' });
    expect(result.success).toBe(false);
  });
});
