const express  = require('express');
const jwt      = require('jsonwebtoken');
const router   = express.Router();
const db       = require('../lib/db');
const { verifyPassphrase } = require('../lib/passphrase');
const { geoLookup }        = require('../lib/geo');
const { sendOwnerAlert }   = require('../lib/email');
const { loginLimiter, inviteLimiter, visitLimiter } = require('../middleware/rateLimit');
const logger = require('../lib/logger');

// ── Record visit ──────────────────────────────────────────────────────────────
router.post('/visit', visitLimiter, async (req, res) => {
  try {
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const geo = await geoLookup(ip);
    await db.from('visitors').insert({
      session_id:  req.body.sid       || null,
      ip,
      user_agent:  req.body.ua        || req.headers['user-agent'] || null,
      referrer:    req.body.ref       || null,
      timezone:    req.body.tz        || null,
      screen:      req.body.screen    || null,
      language:    req.body.lang      || null,
      platform:    req.body.platform  || null,
      cores:       req.body.cores     || null,
      mem:         req.body.mem       || null,
      touch:       req.body.touch     || false,
      connection:  req.body.conn      || null,
      city:        geo.city,
      country:     geo.country,
      country_code: geo.country_code,
      region:      geo.region,
      isp:         geo.isp,
    });
    res.json({ ok: true });
  } catch (e) {
    logger.error('Failed to record visit', { error: e.message });
    res.json({ ok: false });
  }
});

// ── Invite request ────────────────────────────────────────────────────────────
router.post('/invite', inviteLimiter, async (req, res) => {
  const { email, ref } = req.body;
  logger.info('Invite request received', { email, ref });

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    logger.warn('Invalid email in invite request', { email });
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (process.env.INVITES_OPEN !== 'true') {
    logger.warn('Invite requests are closed', { email });
    return res.status(403).json({ error: 'Invite requests are currently closed.' });
  }

  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

  try {
    // Check duplicate
    const { data: existing, error: checkError } = await db.from('invite_requests').select('id,status').eq('email', email).maybeSingle();
    
    if (checkError) {
      logger.error('Error checking existing invite', { error: checkError.message, email });
      return res.status(500).json({ error: 'Database error' });
    }

    if (existing) {
      logger.info('Duplicate invite request (silent return)', { email });
      return res.json({ ok: true }); // silent — don't reveal if already submitted
    }

    const { error: insertError } = await db.from('invite_requests').insert({ email, referral_code: ref || null, ip, status: 'pending' });
    
    if (insertError) {
      logger.error('Failed to insert invite request', { error: insertError.message, email });
      return res.status(500).json({ error: 'Database error' });
    }

    if (process.env.SEND_OWNER_ALERT === 'true') {
      sendOwnerAlert('New invite request', `Email: ${email}\nRef: ${ref || 'none'}\nIP: ${ip}`)
        .then(() => logger.info('Owner alert sent for new invite', { email }))
        .catch((err) => logger.error('Failed to send owner alert', { error: err.message, email }));
    }

    logger.info('Invite request successful', { email });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Unexpected error in invite request', { error: err.message, email });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Member login ──────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const { passphrase } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

  logger.info('Member login attempt', { ip });

  if (!passphrase) {
    logger.warn('Login attempt missing passphrase', { ip });
    return res.status(400).json({ error: 'Passphrase required.' });
  }

  try {
    const { data: members, error: dbError } = await db
      .from('members')
      .select('id,handle,email,passphrase_hash,status')
      .eq('status', 'active');

    if (dbError) {
      logger.error('Error fetching members for login', { error: dbError.message, ip });
      return res.status(500).json({ error: 'Database error' });
    }

    if (!members?.length) {
      logger.warn('No active members found in database', { ip });
      await db.from('failed_logins').insert({ ip, attempted_at: new Date().toISOString() }).catch(()=>{});
      return res.status(401).json({ error: 'ERR_DECRYPT_FAIL — passphrase rejected.' });
    }

    let matched = null;
    for (const m of members) {
      const ok = await verifyPassphrase(passphrase, m.passphrase_hash);
      if (ok) { matched = m; break; }
    }

    if (!matched) {
      logger.warn('Login failed: Passphrase mismatch', { ip });
      await db.from('failed_logins').insert({ ip, attempted_at: new Date().toISOString() }).catch(()=>{});
      return res.status(401).json({ error: 'ERR_DECRYPT_FAIL — passphrase rejected.' });
    }

    logger.info('Login successful', { handle: matched.handle, email: matched.email, ip });

    // Update last login
    await db.from('members').update({ last_login: new Date().toISOString() }).eq('id', matched.id);

    const token = jwt.sign(
      { memberId: matched.id, handle: matched.handle, role: 'member' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || '7d' }
    );

    res.cookie('bl_member', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   7 * 24 * 60 * 60 * 1000,
    });

    res.json({ ok: true, handle: matched.handle });
  } catch (err) {
    logger.error('Unexpected error in member login', { error: err.message, ip });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Owner login ───────────────────────────────────────────────────────────────
router.post('/owner-login', loginLimiter, async (req, res) => {
  const { passphrase } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

  logger.info('Owner login attempt', { ip });

  if (!passphrase) {
    logger.warn('Owner login attempt missing passphrase', { ip });
    return res.status(400).json({ error: 'Passphrase required.' });
  }

  if (!process.env.OWNER_PASSPHRASE_HASH) {
    logger.error('OWNER_PASSPHRASE_HASH not set in .env');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  try {
    const ok = await verifyPassphrase(passphrase, process.env.OWNER_PASSPHRASE_HASH);
    if (!ok) {
      logger.warn('Owner login failed: Passphrase mismatch', { ip });
      return res.status(401).json({ error: 'ERR_DECRYPT_FAIL — passphrase rejected.' });
    }

    logger.info('Owner login successful', { ip });

    const token = jwt.sign(
      { role: 'owner' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.cookie('bl_owner', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   12 * 60 * 60 * 1000,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error('Unexpected error in owner login', { error: err.message, ip });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  logger.info('Logout request');
  res.clearCookie('bl_member');
  res.clearCookie('bl_owner');
  res.json({ ok: true });
});

// ── Stats (public counts for landing page) ────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [{ count: visits }, { count: members }] = await Promise.all([
      db.from('visitors').select('*', { count: 'exact', head: true }),
      db.from('members').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    ]);
    res.json({ visits: visits || 0, members: members || 0 });
  } catch (err) {
    logger.error('Failed to fetch stats', { error: err.message });
    res.json({ visits: 0, members: 0 });
  }
});

module.exports = router;
