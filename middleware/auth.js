const jwt = require('jsonwebtoken');

function requireMember(req, res, next) {
  const token = req.cookies?.bl_member;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'member') return res.status(403).json({ error: 'Forbidden' });
    req.member = payload;
    next();
  } catch {
    res.clearCookie('bl_member');
    return res.status(401).json({ error: 'Session expired' });
  }
}

function requireOwner(req, res, next) {
  const token = req.cookies?.bl_owner;
  if (!token) return res.status(404).json({ error: 'Not found' }); // 404 not 401 — don't reveal the route exists
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'owner') return res.status(404).json({ error: 'Not found' });
    req.owner = payload;
    next();
  } catch {
    res.clearCookie('bl_owner');
    return res.status(404).json({ error: 'Not found' });
  }
}

module.exports = { requireMember, requireOwner };
