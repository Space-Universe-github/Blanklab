const express  = require('express');
const jwt      = require('jsonwebtoken');
const router   = express.Router();
const db       = require('../lib/db');
const { verifyPassphrase } = require('../lib/passphrase');
const { geoLookup }        = require('../lib/geo');
const { sendOwnerAlert }   = require('../lib/email');
const { loginLimiter, inviteLimiter, visitLimiter } = require('../middleware/rateLimit');

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
    res.json({ ok: false });
  }
});

// ── Invite request ────────────────────────────────────────────────────────────
router.post('/invite', inviteLimiter, async (req, res) => {
  const { email, ref } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (process.env.INVITES_OPEN !== 'true') {
    return res.status(403).json({ error: 'Invite requests are currently closed.' });
  }

  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

  // Check duplicate
  const { data: existing } = await db.from('invite_requests').select('id,status').eq('email', email).single();
  if (existing) {
    return res.json({ ok: true }); // silent — don't reveal if already submitted
  }

  await db.from('invite_requests').insert({ email, referral_code: ref || null, ip, status: 'pending' });

  if (process.env.SEND_OWNER_ALERT === 'true') {
    sendOwnerAlert('New invite request', `Email: ${email}\nRef: ${ref || 'none'}\nIP: ${ip}`).catch(() => {});
  }

  res.json({ ok: true });
});

// ── Member login ──────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { passphrase } = req.body;
    if (!passphrase) return res.status(400).json({ error: 'Passphrase required.' });

    const { data: members } = await db
      .from('members')
      .select('id,handle,email,passphrase_hash,status')
      .eq('status', 'active');

    if (!members?.length) {
      // Log failed attempt
      const ip = req.headers['cf-connecting-ip'] || req.ip;
      await db.from('failed_logins').insert({ ip, attempted_at: new Date().toISOString() }).catch(()=>{});
      return res.status(401).json({ error: 'ERR_DECRYPT_FAIL — passphrase rejected.' });
    }

    let matched = null;
    for (const m of members) {
      const ok = await verifyPassphrase(passphrase, m.passphrase_hash);
      if (ok) { matched = m; break; }
    }

    if (!matched) {
      const ip = req.headers['cf-connecting-ip'] || req.ip;
      await db.from('failed_logins').insert({ ip, attempted_at: new Date().toISOString() }).catch(()=>{});
      return res.status(401).json({ error: 'ERR_DECRYPT_FAIL — passphrase rejected.' });
    }

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
  } catch (e) {
    console.error('Login route error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Owner login ───────────────────────────────────────────────────────────────
router.post('/owner-login', loginLimiter, async (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase) return res.status(400).json({ error: 'Passphrase required.' });

  const ok = await verifyPassphrase(passphrase, process.env.OWNER_PASSPHRASE_HASH);
  if (!ok) {
    return res.status(401).json({ error: 'ERR_DECRYPT_FAIL — passphrase rejected.' });
  }

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
});

// ── Logout ────────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('bl_member');
  res.clearCookie('bl_owner');
  res.json({ ok: true });
});

// ── Stats (public counts for landing page) ────────────────────────────────────
router.get('/stats', async (req, res) => {
  const [{ count: visits }, { count: members }] = await Promise.all([
    db.from('visitors').select('*', { count: 'exact', head: true }),
    db.from('members').select('*', { count: 'exact', head: true }).eq('status', 'active'),
  ]);
  res.json({ visits: visits || 0, members: members || 0 });
});

module.exports = router;    });
  }

  res.json({ ok: true });
});

// ── Inbox (messages from owner) ───────────────────────────────────────────────
router.get('/inbox', async (req, res) => {
  const { data: messages } = await db
    .from('messages')
    .select('*')
    .eq('member_id', req.member.memberId)
    .order('sent_at', { ascending: false });

  // Mark as read
  await db.from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('member_id', req.member.memberId)
    .is('read_at', null);

  res.json(messages || []);
});

// ── Announcements ─────────────────────────────────────────────────────────────
router.get('/announcements', async (req, res) => {
  const { data } = await db
    .from('announcements')
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(5);
  res.json(data || []);
});

// ── Update notification prefs ─────────────────────────────────────────────────
router.patch('/notifications', async (req, res) => {
  const { notify_drops } = req.body;
  await db.from('members')
    .update({ notify_drops: !!notify_drops })
    .eq('id', req.member.memberId);
  res.json({ ok: true });
});

// ── Unread counts ─────────────────────────────────────────────────────────────
router.get('/unread', async (req, res) => {
  const { count: unreadDrops } = await db.rpc('count_unread_drops', { mid: req.member.memberId }).single().catch(() => ({ count: 0 }));

  const { count: unreadMessages } = await db
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('member_id', req.member.memberId)
    .is('read_at', null);

  res.json({ drops: unreadDrops || 0, messages: unreadMessages || 0 });
});

module.exports = router;
