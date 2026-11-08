-- Equyvo initial schema. Idempotent-ish (uses IF NOT EXISTS).
-- Run as equyvo_migrator. Apply with: psql -U equyvo_migrator -d equyvo -f 001_init.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- Users & profiles
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cognito_sub   TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE,
  username      TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_cognito_sub ON users(cognito_sub);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS profiles (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name  TEXT,
  bio           TEXT,
  avatar_r2_key TEXT,
  cover_r2_key  TEXT,
  website       TEXT,
  location      TEXT,
  is_verified   BOOLEAN NOT NULL DEFAULT false,
  is_private    BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Subscriptions / entitlements
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_plans (
  id            TEXT PRIMARY KEY,           -- eq_free, eq_plus, eq_premium, eq_creator, eq_creator_pro, eq_business
  name          TEXT NOT NULL,
  price_inr     INTEGER NOT NULL,
  storage_bytes BIGINT NOT NULL,
  max_upload_mb INTEGER NOT NULL,
  monthly_uploads INTEGER NOT NULL,
  ai_suggestions BOOLEAN NOT NULL DEFAULT false,
  analytics     BOOLEAN NOT NULL DEFAULT false,
  ads_enabled   BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id       TEXT NOT NULL REFERENCES subscription_plans(id),
  status        TEXT NOT NULL CHECK (status IN ('active','cancelled','expired','grace')),
  provider      TEXT NOT NULL DEFAULT 'razorpay',
  provider_sub_id TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_subs_user ON user_subscriptions(user_id, status);

CREATE TABLE IF NOT EXISTS usage_ledger (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,              -- YYYY-MM
  bytes_used    BIGINT NOT NULL DEFAULT 0,
  uploads_count INTEGER NOT NULL DEFAULT 0,
  ai_requests   INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period)
);

-- ============================================================
-- Media
-- ============================================================
CREATE TABLE IF NOT EXISTS media (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  uploader_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL UNIQUE,
  content_type  TEXT NOT NULL,
  bytes         BIGINT NOT NULL,
  sha256        TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('image','video','audio','document')),
  width         INTEGER,
  height        INTEGER,
  duration_sec  NUMERIC,
  variants      JSONB,                      -- {thumb, 720p, 1080p}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_media_uploader ON media(uploader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_sha256 ON media(sha256);

-- ============================================================
-- Posts / thoughts / stories / moments (unified content)
-- ============================================================
CREATE TABLE IF NOT EXISTS content (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  author_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('post','thought','story','moment')),
  body          TEXT,
  visibility    TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','followers','private')),
  media_id      UUID REFERENCES media(id) ON DELETE SET NULL,
  chat_with_audience BOOLEAN NOT NULL DEFAULT false,
  chat_prompt   TEXT,
  is_private    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ                 -- for stories (24h)
);
CREATE INDEX IF NOT EXISTS idx_content_author ON content(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_kind_created ON content(kind, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_visibility ON content(visibility, created_at DESC) WHERE deleted_at IS NULL;

-- ============================================================
-- Comments
-- ============================================================
CREATE TABLE IF NOT EXISTS comments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id    UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id     UUID REFERENCES comments(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_comments_content ON comments(content_id, created_at);

-- ============================================================
-- Reactions / likes
-- ============================================================
CREATE TABLE IF NOT EXISTS reactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_kind   TEXT NOT NULL CHECK (target_kind IN ('content','comment')),
  target_id     UUID NOT NULL,
  kind          TEXT NOT NULL,              -- like, love, haha, wow, sad, angry
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_kind, target_id);

-- ============================================================
-- Follow graph
-- ============================================================
CREATE TABLE IF NOT EXISTS follows (
  follower_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

-- ============================================================
-- Communities
-- ============================================================
CREATE TABLE IF NOT EXISTS communities (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  description   TEXT,
  avatar_r2_key TEXT,
  is_private    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_members (
  community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','moderator','member')),
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);

-- ============================================================
-- Messaging
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  is_group      BOOLEAN NOT NULL DEFAULT false,
  title         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_at    TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT,
  media_id        UUID REFERENCES media(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC);

-- ============================================================
-- Notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

-- ============================================================
-- Hashtags & trends
-- ============================================================
CREATE TABLE IF NOT EXISTS hashtags (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tag           TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_hashtags (
  content_id    UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  hashtag_id    UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (content_id, hashtag_id)
);

CREATE TABLE IF NOT EXISTS hashtag_daily_stats (
  hashtag_id    UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  post_count    INTEGER NOT NULL DEFAULT 0,
  engagement    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (hashtag_id, day)
);

-- ============================================================
-- Moderation & reporting
-- ============================================================
CREATE TABLE IF NOT EXISTS reports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_kind   TEXT NOT NULL,
  target_id     UUID NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','actioned','dismissed')),
  ai_score      NUMERIC,
  ai_confidence NUMERIC,
  reviewed_by   UUID REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_id     UUID REFERENCES reports(id) ON DELETE SET NULL,
  actor_id      UUID NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL,
  target_kind   TEXT NOT NULL,
  target_id     UUID NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- AI usage ledger
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_usage (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature       TEXT NOT NULL,              -- content_detection, suggestion, moderation
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER,
  status        TEXT NOT NULL,              -- ok, timeout, error, cached
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, created_at DESC);

-- ============================================================
-- Audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id      UUID REFERENCES users(id),
  action        TEXT NOT NULL,
  target_kind   TEXT,
  target_id     UUID,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- ============================================================
-- Seed subscription plans
-- ============================================================
INSERT INTO subscription_plans (id, name, price_inr, storage_bytes, max_upload_mb, monthly_uploads, ai_suggestions, analytics, ads_enabled) VALUES
  ('eq_free',         'Free',         0,    5*1024*1024*1024::bigint,  25,  100, false, false, true),
  ('eq_plus',         'Plus',         49,   50*1024*1024*1024::bigint, 100, 500, false, false, false),
  ('eq_premium',      'Premium',     149,  250*1024*1024*1024::bigint, 250, 2000, true,  true,  false),
  ('eq_creator',      'Creator',     399,  500*1024*1024*1024::bigint, 500, 5000, true,  true,  false),
  ('eq_creator_pro',  'Creator Pro', 799,  500*1024*1024*1024::bigint, 1000, 10000, true, true, false),
  ('eq_business',     'Business',    0,    1024*1024*1024*1024::bigint, 2000, 100000, true, true, false)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Grants
-- ============================================================
GRANT USAGE ON SCHEMA public TO equyvo_app, equyvo_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO equyvo_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO equyvo_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO equyvo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO equyvo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO equyvo_readonly;
