export const oauthClientsV1 = `
CREATE TABLE oauth_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  auth_method text NOT NULL CHECK (auth_method IN ('none','client_secret_basic','client_secret_post')),
  secret_hash text CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  redirect_uris text NOT NULL CHECK (jsonb_typeof(redirect_uris::jsonb)='array'),
  created_at timestamptz NOT NULL
);
CREATE TABLE oauth_grants (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES oauth_clients(id),
  resource text NOT NULL,
  scopes text NOT NULL CHECK (jsonb_typeof(scopes::jsonb)='array'),
  allowed_note_ids text NOT NULL CHECK (jsonb_typeof(allowed_note_ids::jsonb)='array'),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX oauth_grants_owner_idx ON oauth_grants(owner_id,created_at DESC);
CREATE TABLE oauth_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE oauth_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX oauth_refresh_grant_idx ON oauth_refresh_tokens(grant_id);
CREATE TABLE oauth_rate_limits (
  key text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  attempts integer NOT NULL
);
ALTER TABLE agent_tokens ADD COLUMN expires_at timestamptz;
ALTER TABLE agent_tokens ADD COLUMN oauth_grant_id uuid REFERENCES oauth_grants(id);
ALTER TABLE agent_tokens ADD COLUMN resource text;
ALTER TABLE agent_tokens ADD COLUMN last_used_at timestamptz;
CREATE INDEX agent_tokens_grant_idx ON agent_tokens(oauth_grant_id);
`;
