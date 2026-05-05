// middleware/validate.js
// Middleware factory : prend un schéma Zod, valide req.body, renvoie 400 si invalide.
// Usage : router.post('/api/route', validate(MonSchema), async (req, res) => { ... })

function validate(schema) {
  return (req, res, next) => {
    // safeParse() ne lance jamais d'exception — compatible Zod v3 et v4
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues ?? result.error.errors ?? [];
      const message = issues
        .map(e => `${e.path.join('.') || 'body'}: ${e.message}`)
        .join(' | ');
      return res.status(400).json({ error: `Données invalides — ${message}` });
    }
    req.body = result.data; // données castées/nettoyées par Zod
    next();
  };
}

module.exports = { validate };
