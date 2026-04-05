const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireMember } = require('../middleware/auth');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const logger = require('../lib/logger');

// Markdown renderer — allow common HTML tags
function renderMarkdown(md) {
  try {
    const html = marked.parse(md || '');
    return sanitizeHtml(html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img','h1','h2','h3','h4','del','mark','sup','sub']),
      allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, '*': ['class','style'], img: ['src','alt','title'] },
    });
  } catch (err) {
    logger.error('Markdown rendering failed', { error: err.message });
    return 'Error rendering content.';
  }
}

// All member routes require auth
router.use(requireMember);

// ── Who am I ─────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  logger.info('Fetching member profile', { memberId: req.member.memberId });
  try {
    const { data: member, error: e1 } = await db
      .from('members')
      .select('id,handle,email,joined_at,last_login,status,notify_drops')
      .eq('id', req.member.memberId)
      .single();

    if (e1 || !member) {
      logger.warn('Member profile not found', { memberId: req.member.memberId });
      return res.status(404).json({ error: 'Member not found' });
    }

    const { count: readCount, error: e2 } = await db
      .from('drop_reads')
      .select('*', { count: 'exact', head: true })
      .eq('member_id', req.member.memberId);

    const { count: totalDrops, error: e3 } = await db
      .from('drops')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'published');

    if (e2 || e3) logger.error('Profile stat errors', { errors: [e2, e3].filter(Boolean).map(e => e.message) });

    res.json({ ...member, read_count: readCount || 0, total_drops: totalDrops || 0 });
  } catch (err) {
    logger.error('Failed to fetch member profile', { error: err.message, memberId: req.member.memberId });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Drop feed ─────────────────────────────────────────────────────────────────
router.get('/drops', async (req, res) => {
  const { type, search } = req.query;
  logger.info('Fetching drops for member', { memberId: req.member.memberId, type, search });

  try {
    let query = db
      .from('drops')
      .select('id,issue_number,title,slug,type,excerpt,tags,published_at,external_link')
      .eq('status', 'published')
      .order('published_at', { ascending: false });

    if (type && type !== 'all') query = query.eq('type', type);
    if (search) query = query.ilike('title', `%${search}%`);

    const { data: drops, error: e1 } = await query;
    if (e1) throw e1;

    // Get read status for this member
    const { data: reads, error: e2 } = await db
      .from('drop_reads')
      .select('drop_id')
      .eq('member_id', req.member.memberId);

    const readSet = new Set((reads || []).map(r => r.drop_id));

    // Get reaction counts
    const { data: reactions, error: e3 } = await db
      .from('drop_reactions')
      .select('drop_id,type')
      .in('drop_id', (drops || []).map(d => d.id));

    const reactionMap = {};
    (reactions || []).forEach(r => {
      if (!reactionMap[r.drop_id]) reactionMap[r.drop_id] = {};
      reactionMap[r.drop_id][r.type] = (reactionMap[r.drop_id][r.type] || 0) + 1;
    });

    // Get member's own reactions
    const { data: myReactions, error: e4 } = await db
      .from('drop_reactions')
      .select('drop_id,type')
      .eq('member_id', req.member.memberId);
    
    if (e2 || e3 || e4) logger.error('Drop feed detail errors', { errors: [e2, e3, e4].filter(Boolean).map(e => e.message) });

    const myReactionMap = {};
    (myReactions || []).forEach(r => { myReactionMap[r.drop_id] = r.type; });

    res.json((drops || []).map(d => ({
      ...d,
      has_read: readSet.has(d.id),
      reactions: reactionMap[d.id] || {},
      my_reaction: myReactionMap[d.id] || null,
    })));
  } catch (err) {
    logger.error('Failed to fetch drops for member', { error: err.message, memberId: req.member.memberId });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Single drop ───────────────────────────────────────────────────────────────
router.get('/drops/:slug', async (req, res) => {
  logger.info('Fetching single drop', { slug: req.params.slug, memberId: req.member.memberId });
  try {
    const { data: drop, error: e1 } = await db
      .from('drops')
      .select('*')
      .eq('slug', req.params.slug)
      .eq('status', 'published')
      .single();

    if (e1 || !drop) {
      logger.warn('Drop not found', { slug: req.params.slug });
      return res.status(404).json({ error: 'Not found' });
    }

    // Mark as read
    const { data: existing } = await db
      .from('drop_reads')
      .select('id')
      .eq('member_id', req.member.memberId)
      .eq('drop_id', drop.id)
      .maybeSingle();

    if (!existing) {
      await db.from('drop_reads').insert({
        member_id: req.member.memberId,
        drop_id:   drop.id,
      }).catch(err => logger.error('Failed to mark drop as read', { error: err.message }));
    }

    // Render markdown
    drop.body_html = renderMarkdown(drop.body);

    // Read count
    const { count, error: e2 } = await db
      .from('drop_reads')
      .select('*', { count: 'exact', head: true })
      .eq('drop_id', drop.id);
    
    if (e2) logger.error('Drop read count error', { error: e2.message });

    res.json({ ...drop, read_count: count || 0 });
  } catch (err) {
    logger.error('Failed to fetch drop', { error: err.message, slug: req.params.slug });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Reactions ─────────────────────────────────────────────────────────────────
router.post('/drops/:id/react', async (req, res) => {
  const { type } = req.body; // 'noted' | 'signal' | 'archive' | null (remove)
  const dropId = req.params.id;
  logger.info('Member reacting to drop', { dropId, memberId: req.member.memberId, type });

  try {
    // Delete existing reaction
    await db.from('drop_reactions')
      .delete()
      .eq('member_id', req.member.memberId)
      .eq('drop_id', dropId);

    if (type) {
      const { error } = await db.from('drop_reactions').insert({
        member_id: req.member.memberId,
        drop_id:   dropId,
        type,
      });
      if (error) throw error;
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to react to drop', { error: err.message, dropId });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Inbox (messages from owner) ───────────────────────────────────────────────
router.get('/inbox', async (req, res) => {
  logger.info('Fetching inbox', { memberId: req.member.memberId });
  try {
    const { data: messages, error: e1 } = await db
      .from('messages')
      .select('*')
      .eq('member_id', req.member.memberId)
      .order('sent_at', { ascending: false });

    if (e1) throw e1;

    // Mark as read
    await db.from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('member_id', req.member.memberId)
      .is('read_at', null)
      .catch(err => logger.error('Failed to mark messages as read', { error: err.message }));

    res.json(messages || []);
  } catch (err) {
    logger.error('Failed to fetch inbox', { error: err.message, memberId: req.member.memberId });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Announcements ─────────────────────────────────────────────────────────────
router.get('/announcements', async (req, res) => {
  try {
    const { data, error } = await db
      .from('announcements')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    logger.error('Failed to fetch announcements for member', { error: err.message });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Update notification prefs ─────────────────────────────────────────────────
router.patch('/notifications', async (req, res) => {
  const { notify_drops } = req.body;
  logger.info('Updating notification preferences', { memberId: req.member.memberId, notify_drops });
  try {
    const { error } = await db.from('members')
      .update({ notify_drops: !!notify_drops })
      .eq('id', req.member.memberId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to update notification prefs', { error: err.message, memberId: req.member.memberId });
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Unread counts ─────────────────────────────────────────────────────────────
router.get('/unread', async (req, res) => {
  try {
    const [
      { data: unreadDrops, error: e1 },
      { count: unreadMessages, error: e2 }
    ] = await Promise.all([
      db.rpc('count_unread_drops', { mid: req.member.memberId }).maybeSingle(),
      db.from('messages').select('*', { count: 'exact', head: true }).eq('member_id', req.member.memberId).is('read_at', null)
    ]);

    if (e1 || e2) logger.error('Unread count errors', { errors: [e1, e2].filter(Boolean).map(e => e.message) });

    res.json({ drops: unreadDrops || 0, messages: unreadMessages || 0 });
  } catch (err) {
    logger.error('Failed to fetch unread counts', { error: err.message, memberId: req.member.memberId });
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
