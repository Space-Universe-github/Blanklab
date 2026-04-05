const jwt = require('jsonwebtoken');
const logger = require('../lib/logger');

function requireMember(req, res, next) {
  const token = req.cookies?.bl_member;
  if (!token) {
    logger.warn('Unauthorized: No member token provided', { url: req.originalUrl });
    return res.status(401).json({ error: 'Unauthorized — No token provided' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'member') {
      logger.warn('Forbidden: User is not a member', { role: payload.role, url: req.originalUrl });
      return res.status(403).json({ error: 'Forbidden — Member access required' });
    }
    req.member = payload;
    next();
  } catch (err) {
    logger.error('Session expired or invalid token', { error: err.message });
    res.clearCookie('bl_member');
    return res.status(401).json({ error: 'Session expired — Please log in again' });
  }
}

function requireOwner(req, res, next) {
  const token = req.cookies?.bl_owner;
  if (!token) {
    logger.warn('Unauthorized: No owner token provided (returning 404)', { url: req.originalUrl });
    return res.status(404).json({ error: 'Not found' }); // Obscure the route
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'owner') {
      logger.warn('Forbidden: User is not the owner (returning 404)', { role: payload.role, url: req.originalUrl });
      return res.status(404).json({ error: 'Not found' });
    }
    req.owner = payload;
    next();
  } catch (err) {
    logger.error('Owner session expired or invalid token', { error: err.message });
    res.clearCookie('bl_owner');
    return res.status(404).json({ error: 'Not found' });
  }
}

module.exports = { requireMember, requireOwner };
