import { ID_V1, NOW_V1, optionalTimeV1, timeV1 } from "./columns-v1";

export const noteSharesV1 = [
  `CREATE TABLE note_shares (
    ${ID_V1},
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL ${timeV1("created_at")},
    expires_at TEXT NOT NULL ${timeV1("expires_at")},
    ${optionalTimeV1("revoked_at")},
    CHECK(expires_at > created_at AND julianday(expires_at)-julianday(created_at) <= 7)
  ) STRICT`,
  "CREATE INDEX note_shares_note_idx ON note_shares(note_id,created_at DESC,id)",
  `CREATE TRIGGER note_shares_inactive AFTER UPDATE OF deleted_at,status ON notes
   WHEN NEW.deleted_at IS NOT NULL OR NEW.status='archived'
   BEGIN
     UPDATE note_shares SET revoked_at=COALESCE(revoked_at,${NOW_V1}) WHERE note_id=NEW.id;
   END`,
] as const;
