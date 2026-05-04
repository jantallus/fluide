// middleware/validate.js
// Middleware factory : prend un schéma Zod, valide req.body, renvoie 400 si invalide.
// Usage : router.post('/api/route', validate(MonSchema), async (req, res) => { ... })

const { ZodError } = require('zod');

function validate(schema) {
  return (req, res, next) => {
    try {
      // parse() lance une exception si invalide, sinon retourne la valeur castée/nettoyée
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const message = err.errors
          .map(e => `${e.path.join('.') || 'body'}: ${e.message}`)
          .join(' | ');
        return res.status(400).json({ error: `Données invalides — ${message}` });
      }
      next(err);
    }
  };
}

module.exports = { validate };
