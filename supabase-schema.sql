-- ═══════════════════════════════════════════════════════════════
-- BLANK LABS — Supabase Schema
-- Paste this entire file into the Supabase SQL editor and run.
-- ═══════════════════════════════════════════════════════════════

-- Visitors (passive fingerprint on every page load)
CREATE TABLE IF NOT EXISTS visitors (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id   text,
  ip           text,
  user_agent   text,
  referrer     text,
  timezone     text,
  screen       text,
  language     text,
  platform     text,
  cores        text,
  mem          text,
  touch        boolean DEFAULT false,
  connection   text,
  city         text,
  country      text,
  country_code text,
  region       text,
  isp          text,
  created_at   timestamptz DEFAULT now()
);

-- Invite requests
CREATE TABLE IF NOT EXISTS invite_requests (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email          text UNIQUE NOT NULL,
  referral_code  text,
  ip             text,
  status         text DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  owner_notes    text,
  submitted_at   timestamptz DEFAULT now(),
  reviewed_at    timestamptz
);

-- Members
CREATE TABLE IF NOT EXISTS members (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  handle           text UNIQUE NOT NULL,
  email            text UNIQUE NOT NULL,
  passphrase_hash  text NOT NULL,
  status           text DEFAULT 'active' CHECK (status IN ('active','suspended')),
  notify_drops     boolean DEFAULT true,
  joined_at        timestamptz DEFAULT now(),
  last_login       timestamptz
);

-- Drops (content)
CREATE TABLE IF NOT EXISTS drops (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  issue_number   integer UNIQUE NOT NULL,
  title          text NOT NULL,
  slug           text UNIQUE NOT NULL,
  type           text DEFAULT 'article' CHECK (type IN ('article','link','file','tool','note')),
  body           text,
  excerpt        text,
  external_link  text,
  tags           text[] DEFAULT '{}',
  status         text DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_at   timestamptz,
  created_at     timestamptz DEFAULT now()
);

-- Drop reads (tracks who read what)
CREATE TABLE IF NOT EXISTS drop_reads (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id  uuid REFERENCES members(id) ON DELETE CASCADE,
  drop_id    uuid REFERENCES drops(id) ON DELETE CASCADE,
  read_at    timestamptz DEFAULT now(),
  UNIQUE(member_id, drop_id)
);

-- Drop reactions
CREATE TABLE IF NOT EXISTS drop_reactions (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id  uuid REFERENCES members(id) ON DELETE CASCADE,
  drop_id    uuid REFERENCES drops(id) ON DELETE CASCADE,
  type       text CHECK (type IN ('noted','signal','archive')),
  reacted_at timestamptz DEFAULT now(),
  UNIQUE(member_id, drop_id)
);

-- Messages (owner → member inbox)
CREATE TABLE IF NOT EXISTS messages (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id  uuid REFERENCES members(id) ON DELETE CASCADE,
  subject    text,
  body       text NOT NULL,
  sent_at    timestamptz DEFAULT now(),
  read_at    timestamptz
);

-- Announcements (banner shown to all members)
CREATE TABLE IF NOT EXISTS announcements (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title      text NOT NULL,
  body       text NOT NULL,
  active     boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Failed login tracking
CREATE TABLE IF NOT EXISTS failed_logins (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ip           text,
  attempted_at timestamptz DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_visitors_created    ON visitors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drops_published     ON drops(published_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_drop_reads_member   ON drop_reads(member_id);
CREATE INDEX IF NOT EXISTS idx_drop_reads_drop     ON drop_reads(drop_id);
CREATE INDEX IF NOT EXISTS idx_messages_member     ON messages(member_id);
CREATE INDEX IF NOT EXISTS idx_invite_status       ON invite_requests(status);

-- ── Helper function for unread drops count ───────────────────
CREATE OR REPLACE FUNCTION count_unread_drops(mid uuid)
RETURNS integer AS $$
  SELECT COUNT(*)::integer
  FROM drops d
  WHERE d.status = 'published'
    AND NOT EXISTS (
      SELECT 1 FROM drop_reads dr
      WHERE dr.drop_id = d.id AND dr.member_id = mid
    );
$$ LANGUAGE sql STABLE;

-- ── Row Level Security (disable for service role) ─────────────
-- We use the service_role key so RLS doesn't block us.
-- Do NOT expose your service_role key to the frontend.
ALTER TABLE visitors          DISABLE ROW LEVEL SECURITY;
ALTER TABLE invite_requests   DISABLE ROW LEVEL SECURITY;
ALTER TABLE members           DISABLE ROW LEVEL SECURITY;
ALTER TABLE drops             DISABLE ROW LEVEL SECURITY;
ALTER TABLE drop_reads        DISABLE ROW LEVEL SECURITY;
ALTER TABLE drop_reactions    DISABLE ROW LEVEL SECURITY;
ALTER TABLE messages          DISABLE ROW LEVEL SECURITY;
ALTER TABLE announcements     DISABLE ROW LEVEL SECURITY;
ALTER TABLE failed_logins     DISABLE ROW LEVEL SECURITY;
