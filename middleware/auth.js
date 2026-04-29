const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

const extractToken = (req) => {
  if (req.cookies && req.cookies.auth_token) return req.cookies.auth_token;
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
};

const authenticateUser = (req, res, next) => {
  const token = extractToken(req);
  console.log('Token reçu:', !!token);
  console.log('JWT_SECRET défini:', !!JWT_SECRET);
  if (!token) return res.status(401).json({ error: 'Accès refusé' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Session invalide' });
    req.user = user;
    next();
  });
};

const authenticateAdmin = (req, res, next) => {
  const token = extractToken(req);
  console.log('Token reçu:', !!token);
  console.log('JWT_SECRET défini:', !!JWT_SECRET);
  if (!token) return res.status(401).json({ error: 'Accès refusé' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Session invalide' });
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Interdit : Droits administrateur requis.' });
    }
    req.user = user;
    next();
  });
};

module.exports = { authenticateUser, authenticateAdmin };
