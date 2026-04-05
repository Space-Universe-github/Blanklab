const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('../lib/db');
const { verifyPassphrase } = require('../lib/passphrase');
const { geoLookup } = require('../lib/geo');
const { sendOwnerAlert } = require('../lib/email');
const { loginLimiter, inviteLimiter, visitLimiter } = require('../middleware/rateLimit');

const LOG = '[public]';

function log(...args) {
  console.log(LOG, ...args);
}

function logError(...args) {
  console.error(LOG, ...args);
}

function getIp(req) {
  return req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0]
    || req.ip
    || null;
}

async function logFailedLogin(ip) {
  try {
    const { error } = await db.from('failed_logins').insert({
      ip,
      attempted_at: new Date().toISOString(),
    });

    if (error) {
      logError('failed_logins insert error:', error);
    }
  } catch (err) {
    logError('failed_logins insert threw:', err);
  }
}

// ── Record visit ──────────────────────────────────────────────────────────────
router.post('/visit', visitLimiter, async (req, res) => {
  const ip = getIp(req);

  log('POST /visit', {
    ip,
    hasSid: !!req.body?.sid,
    hasUa: !!req.body?.ua,
  });

  try {
    const geo = await geoLookup(ip);

    const { error } = await db.from('visitors').insert({
      session_id: req.body.sid || null,
      ip,
      user_agent: req.body.ua || req.headers['user-agent'] || null,
      referrer: req.body.ref || null,
      timezone: req.body.tz || null,
      screen: req.body.screen || null,
      language: req.body.lang || null,
      platform: req.body.platform || null,
      cores: req.body.cores || null,
      mem: req.body.mem || null,
      touch: req.body.touch || false,
      connection: req.body.conn || null,
      city: geo.city,
      country: geo.country,
      country_code: geo.country_code,
      region: geo.region,
      isp: geo.isp,
    });

    if (error) {
      logError('POST /visit insert error:', error);
      return res.status(500).json({ ok: false });
    }

    log('POST /visit success');
    res.json({ ok: true });
  } catch (e) {
    logError('POST /visit route error:', e);
    res.json({ ok: false });
  }
});

// ── Invite request ────────────────────────────────────────────────────────────
router.post('/invite', inviteLimiter, async (req, res) => {
  const { email, ref } = req.body;
  const ip = getIp(req);

  log('POST /invite', {
    ip,
    email,
    hasRef: !!ref,
  });

  try {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      log('POST /invite invalid email');
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    if (process.env.INVITES_OPEN !== 'true') {
      log('POST /invite blocked, INVITES_OPEN is not true');
      return res.status(403).json({ error: 'Invite requests are currently closed.' });
    }

    const { data: existingRows, error: existingError } = await db
      .from('invite_requests')
      .select('id,status')
      .eq('email', email)
      .limit(1);

    if (existingError) {
      logError('POST /invite duplicate check error:', existingError);
      return res.status(500).json({ error: 'Database error.' });
    }

    if (existingRows?.length) {
      log('POST /invite duplicate request ignored');
      return res.json({ ok: true });
    }

    const { error: insertError } = await db.from('invite_requests').insert({
      email,
      referral_code: ref || null,
      ip,
      status: 'pending',
    });

    if (insertError) {
      logError('POST /invite insert error:', insertError);
      return res.status(500).json({ error: 'Database error.' });
    }

    log('POST /invite inserted');

    if (process.env.SEND_OWNER_ALERT === 'true') {
      sendOwnerAlert(
        'New invite request',
        `Email: ${email}\nRef: ${ref || 'none'}\nIP: ${ip}`
      ).catch((err) => {
        logError('sendOwnerAlert failed:', err);
      });
    }

    res.json({ ok: true });
  } catch (e) {
    logError('POST /invite route error:', e);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Member login ──────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const ip = getIp(req);
  const { passphrase } = req.body;

  log('POST /login received', {
    ip,
    hasPassphrase: !!passphrase,
  });

  try {
    if (!passphrase) {
      log('POST /login missing passphrase');
      return res.status(400).json({ error: 'Passphrase required.' });
    }

    const { data: members, error: membersError } = await db
      .from('members')
      .select('id,handle,email,passphrase_hash,status')
      .eq('status', 'active');

    if (membersError) {
      logError('POST /login members query error:', membersError);
      return res.status(500).json({ error: 'Database error.' });
    }

    log('POST /login active members loaded', {
      count: members?.length || 0,
    });

    if (!members?.length) {
      log('POST /login no active members found');
      await logFailedLogin(ip);
      return res.status(401).json({ error: 'ERR_DECRYPT_FAIL — passphrase rejected.' });
    }

    let matched = null;

    for (const m of members) {
      try {
        const ok = await verifyPassphrase(passphrase, m.passphrase_hash);
        if (ok) {
          matched = m;
          break;
        }
      } catch (err) {
        logError('POST /login verifyPassphrase error for member', m.id, err);
      }
    }

    if (!matched) {
      log('POST /login passphrase rejected');
      await logFailedLogin(ip);
      return res.status(401).json({ error: 'ERR_DECRYPT_FAIL — passphrase rejected.' });
    }

    const { error: updateError } = await db
      .from('members')
      .update({ last_login: new Date().toISOString() })
      .eq('id', matched.id);

    if (updateError) {
      logError('POST /login last_login update error:', updateError);
    }

    const token = jwt.sign(
      { memberId: matched.id, handle: matched.handle, role: 'member' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || '7d' }
    );

    res.cookie('bl_member', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    log('POST /login success', {
      memberId: matched.id,
      handle: matched.handle,
    });

    res.json({ ok: true, handle: matched.handle });
  } catch (e) {
    logError('POST /login route error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Owner login ───────────────────────────────────────────────────────────────
router.post('/owner-login', loginLimiter, async (req, res) => {
  const { passphrase } = req.body;

  log('POST /owner-login received', {
    hasPassphrase: !!passphrase,
  });

  try {
    if (!passphrase) {
      log('POST /owner-login missing passphrase');
      return res.status(400).json({ error: 'Passphrase required.' });
    }

    const ok = await verifyPassphrase(passphrase, process.env.OWNER_PASSPHRASE_HASH);
    if (!ok) {
      log('POST /owner-login rejected');
      return res.status(401).json({ error: 'ERR_DECRYPT_FAIL — passphrase rejected.' });
    }

    const token = jwt.sign(
      { role: 'owner' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.cookie('bl_owner', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 12 * 60 * 60 * 1000,
    });

    log('POST /owner-login success');
    res.json({ ok: true });
  } catch (e) {
    logError('POST /owner-login route error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  log('POST /logout');
  res.clearCookie('bl_member');
  res.clearCookie('bl_owner');
  res.json({ ok: true });
});

// ── Stats (public counts for landing page) ────────────────────────────────────
router.get('/stats', async (req, res) => {
  log('GET /stats');

  try {
    const [visitsRes, membersRes] = await Promise.all([
      db.from('visitors').select('*', { count: 'exact', head: true }),
      db.from('members').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    ]);

    if (visitsRes.error) {
      logError('GET /stats visits query error:', visitsRes.error);
    }

    if (membersRes.error) {
      logError('GET /stats members query error:', membersRes.error);
    }

    res.json({
      visits: visitsRes.count || 0,
      members: membersRes.count || 0,
    });
  } catch (e) {
    logError('GET /stats route error:', e);
    res.json({ visits: 0, members: 0 });
  }
});

module.exports = router;
