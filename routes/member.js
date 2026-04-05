const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { requireMember } = require('../middleware/auth');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

// Markdown renderer
function renderMarkdown(md) {
  const html = marked.parse(md || '');
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img',
      'h1',
      'h2',
      'h3',
      'h4',
      'del',
      'mark',
      'sup',
      'sub',
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      '*': ['class', 'style'],
      img: ['src', 'alt', 'title'],
    },
  });
}

// All member routes require auth
router.use(requireMember);

// ── Who am I ─────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const { data: member } = await db
    .from('members')
    .select('id,handle,email,joined_at,last_login,status,notify_drops')
    .eq('id', req.member.memberId)
    .single();

  const { count: readCount } = await db
    .from('drop_reads')
    .select('*', { count: 'exact', head: true })
    .eq('member_id', req.member.memberId);

  const { count: totalDrops } = await db
    .from('drops')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'published');

  res.json({
    ...member,
    read_count: readCount || 0,
    total_drops: totalDrops || 0,
  });
});

// ── Drop feed ─────────────────────────────────────────────────────────────────
router.get('/drops', async (req, res) => {
  const { type, search } = req.query;

  let query = db
    .from('drops')
    .select('id,issue_number,title,slug,type,excerpt,tags,published_at,external_link')
    .eq('status', 'published')
    .order('published_at', { ascending: false });

  if (type && type !== 'all') query = query.eq('type', type);
  if (search) query = query.ilike('title', `%${search}%`);

  const { data: drops } = await query;

  const { data: reads } = await db
    .from('drop_reads')
    .select('drop_id')
    .eq('member_id', req.member.memberId);

  const readSet = new Set((reads || []).map(r => r.drop_id));

  const { data: reactions } = await db
    .from('drop_reactions')
    .select('drop_id,type')
    .in('drop_id', (drops || []).map(d => d.id));

  const reactionMap = {};
  (reactions || []).forEach(r => {
    if (!reactionMap[r.drop_id]) reactionMap[r.drop_id] = {};
    reactionMap[r.drop_id][r.type] = (reactionMap[r.drop_id][r.type] || 0) + 1;
  });

  const { data: myReactions } = await db
    .from('drop_reactions')
    .select('drop_id,type')
    .eq('member_id', req.member.memberId);

  const myReactionMap = {};
  (myReactions || []).forEach(r => {
    myReactionMap[r.drop_id] = r.type;
  });

  res.json(
    (drops || []).map(d => ({
      ...d,
      has_read: readSet.has(d.id),
      reactions: reactionMap[d.id] || {},
      my_reaction: myReactionMap[d.id] || null,
    }))
  );
});

// ── Single drop ───────────────────────────────────────────────────────────────
router.get('/drops/:slug', async (req, res) => {
  const { data: drop } = await db
    .from('drops')
    .select('*')
    .eq('slug', req.params.slug)
    .eq('status', 'published')
    .single();

  if (!drop) return res.status(404).json({ error: 'Not found' });

  const { data: existing } = await db
    .from('drop_reads')
    .select('id')
    .eq('member_id', req.member.memberId)
    .eq('drop_id', drop.id)
    .single();

  if (!existing) {
    await db.from('drop_reads').insert({
      member_id: req.member.memberId,
      drop_id: drop.id,
    });
  }

  drop.body_html = renderMarkdown(drop.body);

  const { count } = await db
    .from('drop_reads')
    .select('*', { count: 'exact', head: true })
    .eq('drop_id', drop.id);

  res.json({ ...drop, read_count: count || 0 });
});

// ── Reactions ─────────────────────────────────────────────────────────────────
router.post('/drops/:id/react', async (req, res) => {
  const { type } = req.body;
  const dropId = req.params.id;

  await db
    .from('drop_reactions')
    .delete()
    .eq('member_id', req.member.memberId)
    .eq('drop_id', dropId);

  if (type) {
    await db.from('drop_reactions').insert({
      member_id: req.member.memberId,
      drop_id: dropId,
      type,
    });
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

  await db
    .from('messages')
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

  await db
    .from('members')
    .update({ notify_drops: !!notify_drops })
    .eq('id', req.member.memberId);

  res.json({ ok: true });
});

// ── Unread counts ─────────────────────────────────────────────────────────────
router.get('/unread', async (req, res) => {
  const { count: unreadDrops } = await db
    .rpc('count_unread_drops', { mid: req.member.memberId })
    .single()
    .catch(() => ({ count: 0 }));

  const { count: unreadMessages } = await db
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('member_id', req.member.memberId)
    .is('read_at', null);

  res.json({
    drops: unreadDrops || 0,
    messages: unreadMessages || 0,
  });
});

module.exports = router;
