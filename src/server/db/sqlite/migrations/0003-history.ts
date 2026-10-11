import { arrayV1, createdV1, ID_V1, optionalTimeV1 } from "./columns-v1";

export const historyV1 = [
  `CREATE TABLE note_revisions (
    ${ID_V1},
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    aliases TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL DEFAULT 'edit'
      CHECK (reason IN ('edit','restore','merge','link-mention','task-toggle')),
    ${createdV1()}
  ) STRICT`,
  ...arrayV1("note_revisions", "tags"),
  ...arrayV1("note_revisions", "aliases"),
  "CREATE INDEX note_revisions_note_created_idx ON note_revisions(note_id, created_at DESC)",
  `UPDATE notes SET purge_at = strftime('%Y-%m-%dT%H:%M:%f','now','+30 days') || '000Z'
    WHERE deleted_at IS NOT NULL AND purge_at IS NULL`,
  "CREATE INDEX notes_trash_purge_idx ON notes(purge_at) WHERE deleted_at IS NOT NULL",
  `ALTER TABLE inbox_items ADD COLUMN ${optionalTimeV1("snoozed_until")}`,
  `CREATE INDEX inbox_snoozed_idx ON inbox_items(snoozed_until)
    WHERE discarded_at IS NULL AND promoted_note_id IS NULL AND snoozed_until IS NOT NULL`,
  `CREATE TABLE note_templates (
    ${ID_V1},
    name TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL,
    is_daily_default INTEGER NOT NULL DEFAULT 0 CHECK (is_daily_default IN (0,1)),
    ${createdV1()},
    ${createdV1("updated_at")}
  ) STRICT`,
  "CREATE UNIQUE INDEX note_templates_daily_default_uidx ON note_templates(is_daily_default) WHERE is_daily_default = 1",
] as const;
