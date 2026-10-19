import { createdV1, ID_V1, optionalTimeV1, timeV1 } from "./columns-v1";

export const oauthClientsV1 = [
  `CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
    auth_method TEXT NOT NULL CHECK (auth_method IN ('none','client_secret_basic','client_secret_post')),
    secret_hash TEXT CHECK (secret_hash IS NULL OR (length(secret_hash)=64 AND secret_hash NOT GLOB '*[^0-9a-f]*')),
    redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris) AND json_type(redirect_uris)='array'),
    ${createdV1()}
  ) STRICT`,
  `CREATE TABLE oauth_grants (
    ${ID_V1},
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id),
    resource TEXT NOT NULL,
    scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes)='array'),
    allowed_note_ids TEXT NOT NULL CHECK (json_valid(allowed_note_ids) AND json_type(allowed_note_ids)='array'),
    ${createdV1()}, ${optionalTimeV1("revoked_at")}
  ) STRICT`,
  "CREATE INDEX oauth_grants_owner_idx ON oauth_grants(owner_id,created_at DESC)",
  `CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY NOT NULL CHECK (length(code_hash)=64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
    expires_at TEXT NOT NULL ${timeV1("expires_at")}, ${optionalTimeV1("consumed_at")}
  ) STRICT`,
  `CREATE TABLE oauth_refresh_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL ${timeV1("expires_at")}, ${optionalTimeV1("consumed_at")}
  ) STRICT`,
  "CREATE INDEX oauth_refresh_grant_idx ON oauth_refresh_tokens(grant_id)",
  `CREATE TABLE oauth_rate_limits (
    key TEXT PRIMARY KEY NOT NULL, ${createdV1("started_at")}, attempts INTEGER NOT NULL
  ) STRICT`,
  `ALTER TABLE agent_tokens ADD COLUMN ${optionalTimeV1("expires_at")}`,
  "ALTER TABLE agent_tokens ADD COLUMN oauth_grant_id TEXT REFERENCES oauth_grants(id)",
  "ALTER TABLE agent_tokens ADD COLUMN resource TEXT",
  `ALTER TABLE agent_tokens ADD COLUMN ${optionalTimeV1("last_used_at")}`,
  "CREATE INDEX agent_tokens_grant_idx ON agent_tokens(oauth_grant_id)",
] as const;
