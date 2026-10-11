import { createdV1, ID_V1, optionalTimeV1, timeV1, uuidV1 } from "./columns-v1";

export const configurationV1 = [
  `CREATE TABLE installation_settings (
    singleton INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (singleton = 1),
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    setup_completed INTEGER NOT NULL DEFAULT 0 CHECK (setup_completed IN (0,1)),
    ai TEXT NOT NULL DEFAULT '{"version":2,"chatId":null,"jevId":null}' CHECK (json_valid(ai)),
    ${createdV1("updated_at")}
  ) STRICT`,
  `CREATE TABLE ai_connections (
    ${ID_V1},
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('chat','jev')),
    name TEXT NOT NULL,
    connection TEXT NOT NULL CHECK (json_valid(connection)),
    ${createdV1()},
    ${createdV1("updated_at")}
  ) STRICT`,
  "CREATE INDEX ai_connections_owner_idx ON ai_connections(owner_id, created_at, id)",
  `CREATE TABLE ai_auth_attempts (
    id TEXT PRIMARY KEY NOT NULL ${uuidV1("id")},
    provider TEXT NOT NULL CHECK (provider IN ('github-copilot','openrouter','xai','openai','google')),
    scope_key TEXT NOT NULL,
    browser_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('starting','pending','ready','denied','expired','failed')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    expires_at TEXT NOT NULL ${timeV1("expires_at")},
    ${optionalTimeV1("next_poll_at")},
    ${createdV1()}
  ) STRICT`,
  "CREATE INDEX ai_auth_attempts_expiry_idx ON ai_auth_attempts(expires_at)",
  "CREATE INDEX ai_auth_attempts_scope_idx ON ai_auth_attempts(scope_key)",
  "CREATE TABLE attachment_cleanup (storage_key TEXT PRIMARY KEY NOT NULL) STRICT",
] as const;
