// tests/setup.js — Variables d'environnement minimales pour les tests.
// Chargé avant chaque fichier de test (setupFiles dans jest.config.js).

process.env.JWT_SECRET      = 'test-jwt-secret-suffisamment-long';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.FRONTEND_URL    = 'http://localhost:3000';
process.env.NODE_ENV        = 'test';
