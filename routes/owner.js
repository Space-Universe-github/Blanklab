const express  = require('express');
const router   = express.Router();
const db       = require('../lib/db');
const { requireOwner } = require('../middleware/auth');
const { generatePassphrase, hashPassphrase } = require('../lib/passphrase');
const { sendApproval, sendDenial, sendDropNotification, sendBroadcast, sendDirectMessage } = require('../lib/email');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

function renderMarkdown(md) {
  return sanitizeHtml(marked.parse(md || ''), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img','h1','h2','h3','h4','del','mark','sup','sub']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, '*': ['class','style'], img: ['src','alt','title'] },
  });
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

router.use(requireOwner);

// ── Dashboard stats ───────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const today = new Date(); today.setHours(0,0,0,0);

  const [
    { count: visitsToday },
    { count: visitsTotal },
    { count: activeMembers },
    { count: pendingRequests },
    { count: totalDrops },
    { data: topDrop },
    { count: failedLogins7d },
    { count: unreadMessages },
  ] = await Promise.all([
    db.from('visitors').select('*',{count:'exact',head:true}).gte('created_at', today.toISOString()),
    db.from('visitors').select('*',{count:'exact',head:true}),
    db.from('members').select('*',{count:'exact',head:true}).eq('status','active'),
    db.from('invite_requests').select('*',{count:'exact',head:true}).eq('status','pending'),
    db.from('drops').select('*',{count:'exact',head:true}).eq('status','published'),
    db.from('drop_reads').select('drop_id').order('drop_id').limit(1),
    db.from('failed_logins').select('*',{count:'exact',head:true}).gte('attempted_at', new Date(Date.now()-7*24*60*60*1000).toISOString()),
    db.from('messages').select('*',{count:'exact',head:true}).is('read_at', null),
  ]);

  res.json({
    visits_today:     visitsToday    || 0,
    visits_total:     visitsTotal    || 0,
    active_members:   activeMembers  || 0,
    pending_requests: pendingRequests|| 0,
    total_drops:      totalDrops     || 0,
    failed_logins_7d: failedLogins7d || 0,
    unread_messages:  unreadMessages || 0,
  });
});

// ── Recent activity ────────────────────────────────────────────────────────────
router.get('/activity', async (req, res) => {
  const [{ data: reqs }, { data: reads }, { data: fails }] = await Promise.all([
    db.from('invite_requests').select('email,submitted_at,status').order('submitted_at',{ascending:false}).limit(5),
    db.from('drop_reads').select('member_id,drop_id,read_at,members(handle),drops(title)').order('read_at',{ascending:false}).limit(5),
    db.from('failed_logins').select('ip,attempted_at').order('attempted_at',{ascending:false}).limit(5),
  ]);
  res.json({ requests: reqs||[], reads: reads||[], failed_logins: fails||[] });
});

// ── Invite queue ──────────────────────────────────────────────────────────────
router.get('/requests', async (req, res) => {
  const { status = 'pending' } = req.query;
  const { data } = await db
    .from('invite_requests')
    .select('*')
    .eq('status', status)
    .order('submitted_at', { ascending: false });
  res.json(data || []);
});

router.post('/requests/:id/approve', async (req, res) => {
  const { data: req_ } = await db.from('invite_requests').select('*').eq('id', req.params.id).single();
  if (!req_) return res.status(404).json({ error: 'Not found' });

  const passphrase = generatePassphrase();
  const hash       = await hashPassphrase(passphrase);
  const handle     = req.body.handle || req_.email.split('@')[0].replace(/[^a-z0-9]/gi,'');

  await db.from('members').insert({
    handle,
    email:           req_.email,
    passphrase_hash: hash,
    status:          'active',
    notify_drops:    true,
  });

  await db.from('invite_requests')
    .update({ status: 'approved', reviewed_at: new Date().toISOString() })
    .eq('id', req_.id);

  await sendApproval(req_.email, passphrase);

  res.json({ ok: true, handle, passphrase });
});

router.post('/requests/:id/deny', async (req, res) => {
  const { data: req_ } = await db.from('invite_requests').select('email').eq('id', req.params.id).single();
  if (!req_) return res.status(404).json({ error: 'Not found' });

  await db.from('invite_requests')
    .update({ status: 'denied', reviewed_at: new Date().toISOString(), owner_notes: req.body.note || null })
    .eq('id', req.params.id);

  if (process.env.SEND_DENIAL_EMAILS === 'true') {
    await sendDenial(req_.email);
  }

  res.json({ ok: true });
});

// ── Members ───────────────────────────────────────────────────────────────────
router.get('/members', async (req, res) => {
  const { data: members } = await db
    .from('members')
    .select('id,handle,email,joined_at,last_login,status,notify_drops')
    .order('joined_at', { ascending: false });

  const membersWithCounts = await Promise.all((members||[]).map(async m => {
    const { count } = await db.from('drop_reads').select('*',{count:'exact',head:true}).eq('member_id',m.id);
    return { ...m, read_count: count || 0 };
  }));

  res.json(membersWithCounts);
});

router.patch('/members/:id', async (req, res) => {
  const { status, handle } = req.body;
  const updates = {};
  if (status)  updates.status = status;
  if (handle)  updates.handle = handle;
  await db.from('members').update(updates).eq('id', req.params.id);
  res.json({ ok: true });
});

router.delete('/members/:id', async (req, res) => {
  await db.from('drop_reads').delete().eq('member_id', req.params.id);
  await db.from('drop_reactions').delete().eq('member_id', req.params.id);
  await db.from('messages').delete().eq('member_id', req.params.id);
  await db.from('members').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Messaging ─────────────────────────────────────────────────────────────────
// Broadcast to all / opted-in members
router.post('/broadcast', async (req, res) => {
  const { subject, body, target = 'all' } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body required.' });

  let query = db.from('members').select('email').eq('status','active');
  if (target === 'opted_in') query = query.eq('notify_drops', true);

  const { data: members } = await query;
  const emails = (members||[]).map(m => m.email);

  await sendBroadcast(emails, subject, body);

  // Save as announcement if opted
  if (req.body.save_announcement) {
    await db.from('announcements').insert({ title: subject, body, active: true });
  }

  res.json({ ok: true, sent_to: emails.length });
});

// Direct message to a member
router.post('/members/:id/message', async (req, res) => {
  const { subject, body } = req.body;
  if (!body) return res.status(400).json({ error: 'Body required.' });

  const { data: member } = await db.from('members').select('handle,email').eq('id', req.params.id).single();
  if (!member) return res.status(404).json({ error: 'Not found' });

  // Save to messages table (shows in member inbox)
  await db.from('messages').insert({
    member_id: req.params.id,
    subject:   subject || 'A message from Blank Labs',
    body,
    sent_at:   new Date().toISOString(),
  });

  // Also email them
  await sendDirectMessage(member.email, member.handle, subject, body);

  res.json({ ok: true });
});

// ── Announcements ─────────────────────────────────────────────────────────────
router.get('/announcements', async (req, res) => {
  const { data } = await db.from('announcements').select('*').order('created_at',{ascending:false});
  res.json(data || []);
});

router.post('/announcements', async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required.' });
  const { data } = await db.from('announcements').insert({ title, body, active: true }).select().single();
  res.json(data);
});

router.patch('/announcements/:id', async (req, res) => {
  await db.from('announcements').update({ active: req.body.active }).eq('id', req.params.id);
  res.json({ ok: true });
});

router.delete('/announcements/:id', async (req, res) => {
  await db.from('announcements').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Drops ─────────────────────────────────────────────────────────────────────
router.get('/drops', async (req, res) => {
  const { data: drops } = await db
    .from('drops')
    .select('id,issue_number,title,slug,type,status,published_at,tags')
    .order('published_at', { ascending: false, nullsFirst: true });

  const withCounts = await Promise.all((drops||[]).map(async d => {
    const { count } = await db.from('drop_reads').select('*',{count:'exact',head:true}).eq('drop_id',d.id);
    return { ...d, read_count: count || 0 };
  }));

  res.json(withCounts);
});

router.get('/drops/:id', async (req, res) => {
  const { data } = await db.from('drops').select('*').eq('id', req.params.id).single();
  if (data) data.body_html = renderMarkdown(data.body);
  res.json(data);
});

router.post('/drops', async (req, res) => {
  const { title, type, body, external_link, tags, status = 'draft' } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required.' });

  // Get next issue number
  const { data: last } = await db.from('drops').select('issue_number').order('issue_number',{ascending:false}).limit(1).single();
  const issue_number = (last?.issue_number || 0) + 1;

  let slug = slugify(title);
  // Ensure unique slug
  const { data: existing } = await db.from('drops').select('id').eq('slug', slug).single();
  if (existing) slug = `${slug}-${issue_number}`;

  const { data: drop } = await db.from('drops').insert({
    issue_number,
    title,
    slug,
    type:          type || 'article',
    body:          body || '',
    external_link: external_link || null,
    tags:          tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t=>t.trim())) : [],
    status,
    published_at:  status === 'published' ? new Date().toISOString() : null,
    excerpt:       (body || '').replace(/[#*>`\[\]]/g,'').slice(0, 160).trim(),
  }).select().single();

  // Send notifications if publishing
  if (status === 'published') {
    const { data: members } = await db.from('members').select('email').eq('status','active').eq('notify_drops',true);
    const emails = (members||[]).map(m => m.email);
    if (emails.length) sendDropNotification(emails, drop).catch(()=>{});
  }

  res.json(drop);
});

router.patch('/drops/:id', async (req, res) => {
  const { title, type, body, external_link, tags, status } = req.body;
  const updates = {};
  if (title !== undefined) { updates.title = title; updates.slug = slugify(title); }
  if (type  !== undefined)  updates.type = type;
  if (body  !== undefined) {
    updates.body    = body;
    updates.excerpt = (body||'').replace(/[#*>`\[\]]/g,'').slice(0,160).trim();
    updates.body_html = renderMarkdown(body);
  }
  if (external_link !== undefined) updates.external_link = external_link;
  if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags : tags.split(',').map(t=>t.trim());

  // Publishing transition
  if (status === 'published') {
    const { data: current } = await db.from('drops').select('status').eq('id',req.params.id).single();
    updates.status       = 'published';
    updates.published_at = current?.status !== 'published' ? new Date().toISOString() : undefined;

    if (current?.status !== 'published') {
      const { data: drop } = await db.from('drops').select('*').eq('id',req.params.id).single();
      const { data: members } = await db.from('members').select('email').eq('status','active').eq('notify_drops',true);
      const emails = (members||[]).map(m => m.email);
      if (emails.length) sendDropNotification(emails, { ...drop, ...updates }).catch(()=>{});
    }
  } else if (status) {
    updates.status = status;
  }

  const { data } = await db.from('drops').update(updates).eq('id', req.params.id).select().single();
  res.json(data);
});

router.delete('/drops/:id', async (req, res) => {
  await db.from('drop_reads').delete().eq('drop_id', req.params.id);
  await db.from('drop_reactions').delete().eq('drop_id', req.params.id);
  await db.from('drops').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Visitor log ───────────────────────────────────────────────────────────────
router.get('/visitors', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const { data } = await db
    .from('visitors')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  res.json(data || []);
});

// ── Visitor analytics ─────────────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: visitors } = await db
    .from('visitors')
    .select('created_at,country,referrer,city')
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  // Group by day
  const byDay = {};
  (visitors||[]).forEach(v => {
    const day = v.created_at.slice(0,10);
    byDay[day] = (byDay[day]||0) + 1;
  });

  // Top countries
  const byCountry = {};
  (visitors||[]).forEach(v => {
    if (v.country) byCountry[v.country] = (byCountry[v.country]||0) + 1;
  });
  const topCountries = Object.entries(byCountry).sort((a,b)=>b[1]-a[1]).slice(0,8);

  // Top referrers
  const byRef = {};
  (visitors||[]).forEach(v => {
    const ref = v.referrer || '(direct)';
    byRef[ref] = (byRef[ref]||0) + 1;
  });
  const topReferrers = Object.entries(byRef).sort((a,b)=>b[1]-a[1]).slice(0,8);

  res.json({ byDay, topCountries, topReferrers, total: visitors?.length || 0 });
});

// ── Failed logins ─────────────────────────────────────────────────────────────
router.get('/failed-logins', async (req, res) => {
  const { data } = await db.from('failed_logins').select('*').order('attempted_at',{ascending:false}).limit(50);
  res.json(data || []);
});

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  res.json({
    invites_open:        process.env.INVITES_OPEN === 'true',
    send_denial_emails:  process.env.SEND_DENIAL_EMAILS === 'true',
    send_owner_alert:    process.env.SEND_OWNER_ALERT === 'true',
    site_url:            process.env.SITE_URL,
    from_email:          process.env.FROM_EMAIL,
  });
});

module.exports = router;
