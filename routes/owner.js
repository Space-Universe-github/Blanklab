const express  = require('express');
const router   = express.Router();
const db       = require('../lib/db');
const { requireOwner } = require('../middleware/auth');
const { generatePassphrase, hashPassphrase } = require('../lib/passphrase');
const { sendApproval, sendDenial, sendDropNotification, sendBroadcast, sendDirectMessage } = require('../lib/email');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const logger = require('../lib/logger');

function renderMarkdown(md) {
  try {
    return sanitizeHtml(marked.parse(md || ''), {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img','h1','h2','h3','h4','del','mark','sup','sub']),
      allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, '*': ['class','style'], img: ['src','alt','title'] },
    });
  } catch (err) {
    logger.error('Markdown rendering failed', { error: err.message });
    return 'Error rendering content.';
  }
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

router.use(requireOwner);

// ── Dashboard stats ───────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const today = new Date(); today.setHours(0,0,0,0);
  logger.info('Fetching owner dashboard stats');

  try {
    const [
      { count: visitsToday, error: e1 },
      { count: visitsTotal, error: e2 },
      { count: activeMembers, error: e3 },
      { count: pendingRequests, error: e4 },
      { count: totalDrops, error: e5 },
      { data: topDrop, error: e6 },
      { count: failedLogins7d, error: e7 },
      { count: unreadMessages, error: e8 },
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

    const errors = [e1, e2, e3, e4, e5, e6, e7, e8].filter(Boolean);
    if (errors.length) {
      logger.error('Some stats queries failed', { errors: errors.map(e => e.message) });
    }

    res.json({
      visits_today:     visitsToday    || 0,
      visits_total:     visitsTotal    || 0,
      active_members:   activeMembers  || 0,
      pending_requests: pendingRequests|| 0,
      total_drops:      totalDrops     || 0,
      failed_logins_7d: failedLogins7d || 0,
      unread_messages:  unreadMessages || 0,
    });
  } catch (err) {
    logger.error('Failed to fetch stats', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── Recent activity ────────────────────────────────────────────────────────────
router.get('/activity', async (req, res) => {
  logger.info('Fetching recent activity');
  try {
    const [{ data: reqs, error: e1 }, { data: reads, error: e2 }, { data: fails, error: e3 }] = await Promise.all([
      db.from('invite_requests').select('email,submitted_at,status').order('submitted_at',{ascending:false}).limit(5),
      db.from('drop_reads').select('member_id,drop_id,read_at,members(handle),drops(title)').order('read_at',{ascending:false}).limit(5),
      db.from('failed_logins').select('ip,attempted_at').order('attempted_at',{ascending:false}).limit(5),
    ]);
    
    if (e1 || e2 || e3) logger.error('Activity query errors', { errors: [e1, e2, e3].filter(Boolean).map(e => e.message) });

    res.json({ requests: reqs||[], reads: reads||[], failed_logins: fails||[] });
  } catch (err) {
    logger.error('Failed to fetch activity', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// ── Invite queue ──────────────────────────────────────────────────────────────
router.get('/requests', async (req, res) => {
  const { status = 'pending' } = req.query;
  logger.info('Fetching invite requests', { status });
  try {
    const { data, error } = await db
      .from('invite_requests')
      .select('*')
      .eq('status', status)
      .order('submitted_at', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    logger.error('Failed to fetch invite requests', { error: err.message, status });
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/requests/:id/approve', async (req, res) => {
  const { id } = req.params;
  logger.info('Approving invite request', { id });
  
  try {
    const { data: req_, error: fetchError } = await db.from('invite_requests').select('*').eq('id', id).single();
    if (fetchError || !req_) {
      logger.warn('Invite request not found for approval', { id });
      return res.status(404).json({ error: 'Not found' });
    }

    const passphrase = generatePassphrase();
    const hash       = await hashPassphrase(passphrase);
    const handle     = req.body.handle || req_.email.split('@')[0].replace(/[^a-z0-9]/gi,'');

    const { error: insertError } = await db.from('members').insert({
      handle,
      email:           req_.email,
      passphrase_hash: hash,
      status:          'active',
      notify_drops:    true,
    });

    if (insertError) {
      logger.error('Failed to create member from invite', { error: insertError.message, email: req_.email });
      return res.status(500).json({ error: 'Failed to create member' });
    }

    await db.from('invite_requests')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .eq('id', req_.id);

    logger.info('Invite approved and member created', { handle, email: req_.email });

    await sendApproval(req_.email, passphrase)
      .then(() => logger.info('Approval email sent', { email: req_.email }))
      .catch(err => logger.error('Failed to send approval email', { error: err.message, email: req_.email }));

    res.json({ ok: true, handle, passphrase });
  } catch (err) {
    logger.error('Error during invite approval', { error: err.message, id });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/requests/:id/deny', async (req, res) => {
  const { id } = req.params;
  logger.info('Denying invite request', { id });
  
  try {
    const { data: req_, error: fetchError } = await db.from('invite_requests').select('email').eq('id', id).single();
    if (fetchError || !req_) return res.status(404).json({ error: 'Not found' });

    await db.from('invite_requests')
      .update({ status: 'denied', reviewed_at: new Date().toISOString(), owner_notes: req.body.note || null })
      .eq('id', id);

    if (process.env.SEND_DENIAL_EMAILS === 'true') {
      await sendDenial(req_.email)
        .then(() => logger.info('Denial email sent', { email: req_.email }))
        .catch(err => logger.error('Failed to send denial email', { error: err.message, email: req_.email }));
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error('Error during invite denial', { error: err.message, id });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Members ───────────────────────────────────────────────────────────────────
router.get('/members', async (req, res) => {
  logger.info('Fetching all members');
  try {
    const { data: members, error } = await db
      .from('members')
      .select('id,handle,email,joined_at,last_login,status,notify_drops')
      .order('joined_at', { ascending: false });

    if (error) throw error;

    const membersWithCounts = await Promise.all((members||[]).map(async m => {
      const { count } = await db.from('drop_reads').select('*',{count:'exact',head:true}).eq('member_id',m.id);
      return { ...m, read_count: count || 0 };
    }));

    res.json(membersWithCounts);
  } catch (err) {
    logger.error('Failed to fetch members', { error: err.message });
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/members/:id', async (req, res) => {
  const { status, handle } = req.body;
  const updates = {};
  if (status)  updates.status = status;
  if (handle)  updates.handle = handle;
  
  logger.info('Updating member', { id: req.params.id, updates });
  
  try {
    const { error } = await db.from('members').update(updates).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to update member', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/members/:id', async (req, res) => {
  logger.info('Deleting member', { id: req.params.id });
  try {
    await db.from('drop_reads').delete().eq('member_id', req.params.id);
    await db.from('drop_reactions').delete().eq('member_id', req.params.id);
    await db.from('messages').delete().eq('member_id', req.params.id);
    const { error } = await db.from('members').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to delete member', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Messaging ─────────────────────────────────────────────────────────────────
router.post('/broadcast', async (req, res) => {
  const { subject, body, target = 'all' } = req.body;
  logger.info('Sending broadcast', { subject, target });
  
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body required.' });

  try {
    let query = db.from('members').select('email').eq('status','active');
    if (target === 'opted_in') query = query.eq('notify_drops', true);

    const { data: members, error } = await query;
    if (error) throw error;
    
    const emails = (members||[]).map(m => m.email);
    if (emails.length) {
      await sendBroadcast(emails, subject, body);
      logger.info('Broadcast emails sent', { count: emails.length });
    }

    if (req.body.save_announcement) {
      await db.from('announcements').insert({ title: subject, body, active: true });
      logger.info('Broadcast saved as announcement');
    }

    res.json({ ok: true, sent_to: emails.length });
  } catch (err) {
    logger.error('Failed to send broadcast', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/members/:id/message', async (req, res) => {
  const { subject, body } = req.body;
  const { id } = req.params;
  logger.info('Sending direct message to member', { id, subject });
  
  if (!body) return res.status(400).json({ error: 'Body required.' });

  try {
    const { data: member, error: fetchError } = await db.from('members').select('handle,email').eq('id', id).single();
    if (fetchError || !member) return res.status(404).json({ error: 'Not found' });

    await db.from('messages').insert({
      member_id: id,
      subject:   subject || 'A message from Blank Labs',
      body,
      sent_at:   new Date().toISOString(),
    });

    await sendDirectMessage(member.email, member.handle, subject, body);
    logger.info('Direct message sent', { email: member.email });

    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to send direct message', { error: err.message, id });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Announcements ─────────────────────────────────────────────────────────────
router.get('/announcements', async (req, res) => {
  try {
    const { data, error } = await db.from('announcements').select('*').order('created_at',{ascending:false});
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    logger.error('Failed to fetch announcements', { error: err.message });
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/announcements', async (req, res) => {
  const { title, body } = req.body;
  logger.info('Creating announcement', { title });
  if (!title || !body) return res.status(400).json({ error: 'Title and body required.' });
  
  try {
    const { data, error } = await db.from('announcements').insert({ title, body, active: true }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    logger.error('Failed to create announcement', { error: err.message });
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/announcements/:id', async (req, res) => {
  logger.info('Updating announcement', { id: req.params.id, active: req.body.active });
  try {
    const { error } = await db.from('announcements').update({ active: req.body.active }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to update announcement', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/announcements/:id', async (req, res) => {
  logger.info('Deleting announcement', { id: req.params.id });
  try {
    const { error } = await db.from('announcements').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to delete announcement', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Drops ─────────────────────────────────────────────────────────────────────
router.get('/drops', async (req, res) => {
  try {
    const { data: drops, error } = await db
      .from('drops')
      .select('id,issue_number,title,slug,type,status,published_at,tags')
      .order('published_at', { ascending: false, nullsFirst: true });

    if (error) throw error;

    const withCounts = await Promise.all((drops||[]).map(async d => {
      const { count } = await db.from('drop_reads').select('*',{count:'exact',head:true}).eq('drop_id',d.id);
      return { ...d, read_count: count || 0 };
    }));

    res.json(withCounts);
  } catch (err) {
    logger.error('Failed to fetch drops', { error: err.message });
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/drops/:id', async (req, res) => {
  try {
    const { data, error } = await db.from('drops').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    if (data) data.body_html = renderMarkdown(data.body);
    res.json(data);
  } catch (err) {
    logger.error('Failed to fetch drop', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/drops', async (req, res) => {
  const { title, type, body, external_link, tags, status = 'draft' } = req.body;
  logger.info('Creating drop', { title, status });
  if (!title) return res.status(400).json({ error: 'Title required.' });

  try {
    const { data: last } = await db.from('drops').select('issue_number').order('issue_number',{ascending:false}).limit(1).single();
    const issue_number = (last?.issue_number || 0) + 1;

    let slug = slugify(title);
    const { data: existing } = await db.from('drops').select('id').eq('slug', slug).single();
    if (existing) slug = `${slug}-${issue_number}`;

    const { data: drop, error } = await db.from('drops').insert({
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

    if (error) throw error;

    if (status === 'published') {
      const { data: members } = await db.from('members').select('email').eq('status','active').eq('notify_drops',true);
      const emails = (members||[]).map(m => m.email);
      if (emails.length) {
        sendDropNotification(emails, drop)
          .then(() => logger.info('Drop notification emails sent', { count: emails.length }))
          .catch(err => logger.error('Failed to send drop notifications', { error: err.message }));
      }
    }

    res.json(drop);
  } catch (err) {
    logger.error('Failed to create drop', { error: err.message });
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/drops/:id', async (req, res) => {
  const { title, type, body, external_link, tags, status } = req.body;
  const { id } = req.params;
  logger.info('Updating drop', { id, status });
  
  try {
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

    if (status === 'published') {
      const { data: current } = await db.from('drops').select('status').eq('id', id).single();
      updates.status       = 'published';
      updates.published_at = current?.status !== 'published' ? new Date().toISOString() : undefined;

      if (current?.status !== 'published') {
        const { data: drop } = await db.from('drops').select('*').eq('id', id).single();
        const { data: members } = await db.from('members').select('email').eq('status','active').eq('notify_drops',true);
        const emails = (members||[]).map(m => m.email);
        if (emails.length) sendDropNotification(emails, { ...drop, ...updates }).catch(()=>{});
      }
    } else if (status) {
      updates.status = status;
    }

    const { data, error } = await db.from('drops').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    logger.error('Failed to update drop', { error: err.message, id });
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/drops/:id', async (req, res) => {
  logger.info('Deleting drop', { id: req.params.id });
  try {
    await db.from('drop_reads').delete().eq('drop_id', req.params.id);
    await db.from('drop_reactions').delete().eq('drop_id', req.params.id);
    const { error } = await db.from('drops').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to delete drop', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Visitor log ───────────────────────────────────────────────────────────────
router.get('/visitors', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  try {
    const { data, error } = await db
      .from('visitors')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    logger.error('Failed to fetch visitors', { error: err.message });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Visitor analytics ─────────────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  logger.info('Fetching visitor analytics', { days }); 
