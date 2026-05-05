module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFiles: ['./tests/setup.js'],
  // Timeout plus long pour les tests d'intégration
  testTimeout: 10000,
  // Affiche le nom de chaque test
  verbose: true,
};
