import { arrayV1, createdV1, uuidV1 } from "./columns-v1";

export const retrievalChatV1 = [
  `CREATE TABLE note_semantic_index (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
    ${createdV1("updated_at")},
    PRIMARY KEY (note_id, model_id)
  ) STRICT`,
  `CREATE TABLE note_passages (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN -2147483648 AND 2147483647),
    heading TEXT NOT NULL,
    start_line INTEGER NOT NULL CHECK (start_line BETWEEN -2147483648 AND 2147483647),
    end_line INTEGER NOT NULL CHECK (end_line BETWEEN -2147483648 AND 2147483647),
    content TEXT NOT NULL,
    embedding TEXT NOT NULL,
    PRIMARY KEY (note_id, model_id, ordinal)
  ) STRICT`,
  ...arrayV1("note_passages", "embedding", 768),
  "CREATE INDEX note_passages_model_idx ON note_passages(model_id)",
  `CREATE TABLE chat_requests (
    id TEXT PRIMARY KEY NOT NULL ${uuidV1("id")},
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    assistant_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE
  ) STRICT`,
  "CREATE INDEX chat_requests_thread_idx ON chat_requests(thread_id)",
  "CREATE INDEX chat_requests_assistant_idx ON chat_requests(assistant_id)",
] as const;
