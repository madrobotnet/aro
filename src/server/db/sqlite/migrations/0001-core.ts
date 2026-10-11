import { arrayV1, createdV1, ID_V1, optionalTimeV1, timeV1 } from "./columns-v1";

export const coreV1 = [
  `CREATE TABLE users (
    ${ID_V1},
    password_hash TEXT NOT NULL,
    ${createdV1()},
    ${createdV1("updated_at")}
  ) STRICT`,
  `CREATE TABLE sessions (
    ${ID_V1},
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash BLOB NOT NULL,
    ${createdV1()},
    expires_at TEXT NOT NULL ${timeV1("expires_at")},
    ${optionalTimeV1("revoked_at")},
    user_agent TEXT,
    ip TEXT,
    ${optionalTimeV1("last_seen_at")}
  ) STRICT`,
  "CREATE UNIQUE INDEX sessions_token_hash_uidx ON sessions(token_hash)",
  "CREATE INDEX sessions_user_idx ON sessions(user_id)",
  `CREATE TABLE auth_login_failures (
    client_key TEXT NOT NULL,
    ${createdV1("attempted_at")}
  ) STRICT`,
  "CREATE INDEX auth_login_failures_client_time_idx ON auth_login_failures(client_key, attempted_at)",
  `CREATE TABLE notes (
    ${ID_V1},
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    ${createdV1()},
    ${createdV1("updated_at")},
    ${optionalTimeV1("deleted_at")},
    ${optionalTimeV1("purge_at")},
    tags TEXT NOT NULL DEFAULT '[]',
    aliases TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
    source_url TEXT,
    daily_date TEXT CHECK (daily_date IS NULL OR (
      daily_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND
      date(daily_date, '+0 days') IS daily_date)),
    search_embedding TEXT,
    ${optionalTimeV1("search_embedded_at")},
    search_source_hash TEXT
  ) STRICT`,
  ...arrayV1("notes", "tags"),
  ...arrayV1("notes", "aliases"),
  ...arrayV1("notes", "search_embedding", 128),
  "CREATE INDEX notes_active_updated_idx ON notes(updated_at DESC) WHERE deleted_at IS NULL",
  "CREATE UNIQUE INDEX notes_daily_date_uidx ON notes(daily_date) WHERE daily_date IS NOT NULL AND deleted_at IS NULL",
  `CREATE TABLE links (
    ${ID_V1},
    from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    to_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'link',
    ${createdV1()},
    CHECK (from_note_id <> to_note_id),
    UNIQUE (from_note_id, to_note_id, relation)
  ) STRICT`,
  "CREATE INDEX links_from_note_idx ON links(from_note_id)",
  "CREATE INDEX links_to_note_idx ON links(to_note_id)",
  `CREATE TABLE unresolved_links (
    from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_title TEXT NOT NULL,
    PRIMARY KEY (from_note_id, target_title)
  ) STRICT`,
  "CREATE INDEX unresolved_links_target_idx ON unresolved_links(lower(target_title))",
  `CREATE TABLE inbox_items (
    ${ID_V1},
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    url TEXT,
    promoted_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
    ${optionalTimeV1("discarded_at")},
    ${createdV1()},
    suggestions TEXT CHECK (suggestions IS NULL OR json_valid(suggestions))
  ) STRICT`,
  "CREATE INDEX inbox_open_idx ON inbox_items(created_at DESC) WHERE discarded_at IS NULL AND promoted_note_id IS NULL",
  "CREATE INDEX inbox_promoted_note_idx ON inbox_items(promoted_note_id)",
  `CREATE TABLE attachments (
    ${ID_V1},
    note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
    inbox_item_id TEXT REFERENCES inbox_items(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 9007199254740991),
    storage_key TEXT NOT NULL,
    ${createdV1()}
  ) STRICT`,
  "CREATE INDEX attachments_note_idx ON attachments(note_id)",
  "CREATE INDEX attachments_inbox_idx ON attachments(inbox_item_id)",
  `CREATE TABLE chat_threads (
    ${ID_V1},
    title TEXT,
    ${createdV1()},
    ${createdV1("updated_at")},
    ${optionalTimeV1("archived_at")}
  ) STRICT`,
  `CREATE TABLE chat_messages (
    ${ID_V1},
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    citations TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations)),
    routing TEXT CHECK (routing IS NULL OR json_valid(routing)),
    ${createdV1()}
  ) STRICT`,
  "CREATE INDEX chat_messages_thread_idx ON chat_messages(thread_id, created_at, id)",
] as const;
