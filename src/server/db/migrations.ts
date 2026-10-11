/**
 * Ordered, idempotent schema migrations.
 *
 * The first migration is written with IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so it
 * applies cleanly both to an empty database and to the v1 production database
 * (same table names: notes, inbox_items, links, attachments, chat_*, users, sessions).
 * Never edit a shipped migration; append a new one.
 */
export type Migration = { id: string; sql: string };

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_v2_baseline",
    sql: `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Auth ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz NULL,
  user_agent  text NULL,
  ip          inet NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_uidx ON sessions (token_hash);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS auth_login_failures (
  client_key    text NOT NULL,
  attempted_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_login_failures_client_time_idx
  ON auth_login_failures (client_key, attempted_at);

-- Notes --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz NULL,
  purge_at    timestamptz NULL
);
ALTER TABLE notes ADD COLUMN IF NOT EXISTS tags        text[]  NOT NULL DEFAULT '{}';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS aliases     text[]  NOT NULL DEFAULT '{}';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS pinned      boolean NOT NULL DEFAULT false;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS source_url  text    NULL;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS daily_date  date    NULL;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS search_embedding   vector(128);
ALTER TABLE notes ADD COLUMN IF NOT EXISTS search_embedded_at timestamptz;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS search_source_hash text;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(body, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS notes_active_updated_idx ON notes (updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS notes_tags_gin ON notes USING gin (tags);
CREATE INDEX IF NOT EXISTS notes_search_tsv_gin ON notes USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS notes_title_trgm ON notes USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS notes_body_trgm ON notes USING gin (body gin_trgm_ops);
CREATE INDEX IF NOT EXISTS notes_search_embed_hnsw ON notes USING hnsw (search_embedding vector_cosine_ops);
CREATE UNIQUE INDEX IF NOT EXISTS notes_daily_date_uidx ON notes (daily_date)
  WHERE daily_date IS NOT NULL AND deleted_at IS NULL;

-- Links (wikilinks resolved to note ids). relation 'link' is the only one v2 writes.
CREATE TABLE IF NOT EXISTS links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_note_id  uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_note_id    uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  relation      text NOT NULL DEFAULT 'link',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (from_note_id <> to_note_id),
  UNIQUE (from_note_id, to_note_id, relation)
);
CREATE INDEX IF NOT EXISTS links_from_note_idx ON links (from_note_id);
CREATE INDEX IF NOT EXISTS links_to_note_idx ON links (to_note_id);

-- Wikilinks whose target title does not exist yet. Resolved when a matching note appears.
CREATE TABLE IF NOT EXISTS unresolved_links (
  from_note_id  uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_title  text NOT NULL,
  PRIMARY KEY (from_note_id, target_title)
);
CREATE INDEX IF NOT EXISTS unresolved_links_target_idx ON unresolved_links (lower(target_title));

-- Inbox --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbox_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL,
  body              text NOT NULL DEFAULT '',
  source            text NOT NULL,
  url               text NULL,
  promoted_note_id  uuid NULL REFERENCES notes(id) ON DELETE SET NULL,
  discarded_at      timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  suggestions       jsonb NULL
);
CREATE INDEX IF NOT EXISTS inbox_open_idx ON inbox_items (created_at DESC)
  WHERE discarded_at IS NULL AND promoted_note_id IS NULL;

-- Attachments ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id        uuid NULL REFERENCES notes(id) ON DELETE CASCADE,
  inbox_item_id  uuid NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  mime           text NOT NULL,
  size_bytes     bigint NOT NULL,
  storage_key    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- v2 allows attachments uploaded before they are referenced by a note.
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_check;

-- Chat ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_threads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('user','assistant','system')),
  content      text NOT NULL,
  citations    jsonb NOT NULL DEFAULT '[]',
  routing      jsonb NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- v1 forced every assistant message to carry a citation; v2 allows "not in your notes" answers.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_check;
CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON chat_messages (thread_id, created_at, id);
`,
  },
  {
    id: "0002_installation_settings",
    sql: `
CREATE TABLE IF NOT EXISTS installation_settings (
  singleton        boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setup_completed  boolean NOT NULL DEFAULT false,
  ai               jsonb NOT NULL DEFAULT '{"chat":null,"jev":null}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: "0003_ai_connections",
    sql: `
CREATE TABLE ai_connections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('chat', 'jev')),
  name        text NOT NULL,
  connection  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_connections_owner_idx ON ai_connections (owner_id, created_at, id);

WITH legacy AS MATERIALIZED (
  SELECT singleton, owner_id, ai,
    CASE WHEN ai->'chat' IS NOT NULL AND ai->'chat' <> 'null'::jsonb
      THEN gen_random_uuid() END AS chat_id,
    CASE WHEN ai->'jev' IS NOT NULL AND ai->'jev' <> 'null'::jsonb
      THEN gen_random_uuid() END AS jev_id
  FROM installation_settings
), chat_profiles AS (
  INSERT INTO ai_connections (id, owner_id, purpose, name, connection)
  SELECT chat_id, owner_id, 'chat', '기존 채팅 연결', ai->'chat'
  FROM legacy WHERE chat_id IS NOT NULL RETURNING id
), jev_profiles AS (
  INSERT INTO ai_connections (id, owner_id, purpose, name, connection)
  SELECT jev_id, owner_id, 'jev', '기존 Jev 연결', ai->'jev'
  FROM legacy WHERE jev_id IS NOT NULL RETURNING id
)
UPDATE installation_settings s
SET ai = jsonb_build_object('version', 2, 'chatId', legacy.chat_id, 'jevId', legacy.jev_id)
FROM legacy WHERE s.singleton = legacy.singleton;

ALTER TABLE installation_settings ALTER COLUMN ai
  SET DEFAULT '{"version":2,"chatId":null,"jevId":null}'::jsonb;

CREATE TABLE ai_auth_attempts (
  id             uuid PRIMARY KEY,
  provider       text NOT NULL CHECK (provider IN ('github-copilot', 'openrouter', 'xai')),
  scope_key      text NOT NULL,
  browser_hash   text NOT NULL,
  status         text NOT NULL CHECK (status IN ('starting', 'pending', 'ready', 'denied', 'expired', 'failed')),
  payload        jsonb NOT NULL,
  expires_at     timestamptz NOT NULL,
  next_poll_at   timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_auth_attempts_expiry_idx ON ai_auth_attempts (expires_at);
CREATE INDEX ai_auth_attempts_scope_idx ON ai_auth_attempts (scope_key);
`,
  },
  {
    id: "0004_reset_legacy_embeddings",
    sql: `
-- v1 used the same content hash for a different 128-dimensional feature space.
-- Clear every cache, including archives/trash that may be restored later.
-- Current search rebuilds active notes in bounded batches before using them.
UPDATE notes
SET search_embedding = NULL, search_embedded_at = NULL, search_source_hash = NULL
WHERE search_embedding IS NOT NULL
   OR search_embedded_at IS NOT NULL
   OR search_source_hash IS NOT NULL;
`,
  },
  {
    id: "0005_attachment_cleanup",
    sql: `
CREATE TABLE attachment_cleanup (
  storage_key text PRIMARY KEY
);
`,
  },
  {
    id: "0006_browser_auth_providers",
    sql: `
ALTER TABLE ai_auth_attempts DROP CONSTRAINT ai_auth_attempts_provider_check;
ALTER TABLE ai_auth_attempts ADD CONSTRAINT ai_auth_attempts_provider_check
  CHECK (provider IN ('github-copilot', 'openrouter', 'xai', 'openai', 'google'));
`,
  },
  {
    id: "0007_note_revisions",
    sql: `
-- reason names the change that replaced this snapshot (see src/lib/note-revisions.ts).
CREATE TABLE note_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id     uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text NOT NULL,
  tags        text[] NOT NULL DEFAULT '{}',
  aliases     text[] NOT NULL DEFAULT '{}',
  reason      text NOT NULL DEFAULT 'edit'
    CHECK (reason IN ('edit', 'restore', 'merge', 'link-mention', 'task-toggle')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX note_revisions_note_created_idx ON note_revisions (note_id, created_at DESC);

-- Trash retention: notes already in the trash start their 30-day clock at upgrade time.
UPDATE notes SET purge_at = now() + interval '30 days'
WHERE deleted_at IS NOT NULL AND purge_at IS NULL;
CREATE INDEX notes_trash_purge_idx ON notes (purge_at) WHERE deleted_at IS NOT NULL;
`,
  },
  {
    id: "0008_inbox_snooze",
    sql: `
ALTER TABLE inbox_items ADD COLUMN snoozed_until timestamptz NULL;
CREATE INDEX inbox_snoozed_idx ON inbox_items (snoozed_until)
  WHERE discarded_at IS NULL AND promoted_note_id IS NULL AND snoozed_until IS NOT NULL;
`,
  },
  {
    id: "0009_note_templates",
    sql: `
CREATE TABLE note_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL UNIQUE,
  body              text NOT NULL,
  is_daily_default  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- At most one template can be the daily default.
CREATE UNIQUE INDEX note_templates_daily_default_uidx ON note_templates (is_daily_default)
  WHERE is_daily_default;
`,
  },
  {
    id: "0010_passage_embeddings",
    sql: `
CREATE TABLE note_semantic_index (
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  source_hash text NOT NULL,
  complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, model_id)
);
CREATE TABLE note_passages (
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  source_hash text NOT NULL,
  ordinal integer NOT NULL,
  heading text NOT NULL,
  start_line integer NOT NULL,
  end_line integer NOT NULL,
  content text NOT NULL,
  embedding vector(768) NOT NULL,
  PRIMARY KEY (note_id, model_id, ordinal)
);
CREATE INDEX note_passages_model_idx ON note_passages(model_id);
`,
  },
  {
    id: "0011_chat_requests",
    sql: `
CREATE TABLE chat_requests (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  content text NOT NULL,
  assistant_id uuid NULL REFERENCES chat_messages(id) ON DELETE CASCADE
);
CREATE INDEX chat_requests_thread_idx ON chat_requests(thread_id);
`,
  },
  {
    id: "0012_capture_requests",
    sql: `
-- Retain replay identity/outcome even if an inbox item or owner is removed.
CREATE TABLE capture_requests (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  content text NOT NULL,
  outcome text NOT NULL CHECK (jsonb_typeof(outcome::jsonb) = 'object')
);
`,
  },
  {
    id: "0013_agent_access",
    sql: `
CREATE TABLE agent_tokens (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text NOT NULL CHECK (jsonb_typeof(scopes::jsonb)='array'),
  allowed_note_ids text NOT NULL CHECK (jsonb_typeof(allowed_note_ids::jsonb)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE TABLE agent_proposals (
  id uuid PRIMARY KEY,
  token_id uuid NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
  note_id uuid NOT NULL,
  expected_version text NOT NULL,
  patch text NOT NULL CHECK (jsonb_typeof(patch::jsonb)='object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
CREATE INDEX agent_proposals_status_idx ON agent_proposals(status,created_at DESC,id);
CREATE TABLE agent_requests (
  token_id uuid NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
  tool text NOT NULL CHECK (tool IN ('capture_inbox','propose_note_update')),
  request_id uuid NOT NULL,
  content_hash text NOT NULL,
  outcome text NOT NULL CHECK (jsonb_typeof(outcome::jsonb)='object'),
  PRIMARY KEY(token_id,tool,request_id)
);
CREATE TABLE agent_activity (
  id uuid PRIMARY KEY,
  token_id uuid NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
  tool text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','denied','error')),
  target_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_activity_time_idx ON agent_activity(created_at DESC,id);
`,
  },
  {
    id: "0014_note_shares",
    sql: `
CREATE TABLE note_shares (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
);
CREATE INDEX note_shares_note_idx ON note_shares(note_id,created_at DESC,id);
CREATE FUNCTION revoke_inactive_note_shares() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.status = 'archived' THEN
    UPDATE note_shares SET revoked_at = COALESCE(revoked_at,now()) WHERE note_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER note_shares_inactive AFTER UPDATE OF deleted_at,status ON notes
FOR EACH ROW EXECUTE FUNCTION revoke_inactive_note_shares();
`,
  },
];
