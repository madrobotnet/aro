import type { NoteRef } from "@/lib/types";
import { normalizeTitle } from "@/lib/wikilinks";
import { queryOne } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { readSQLiteStringArray } from "@/server/db/sqlite";

/** Read-only counterpart of getOrCreateByTitle, including archived notes.
 * Keep each backend's established oldest-match ordering, not autocomplete's
 * bounded substring search or materialized links' canonical-title preference.
 */
export async function findNoteReference(title: string): Promise<NoteRef | null> {
  const key = normalizeTitle(title);
  if (databaseBackend() === "sqlite") {
    const rows = (await sqliteStore()).all<{ id: string; title: string; aliases: string }>(
      "SELECT id,title,aliases FROM notes WHERE deleted_at IS NULL ORDER BY created_at,id",
    );
    const row = rows.find((row) => normalizeTitle(row.title) === key
      || readSQLiteStringArray(row.aliases).some((alias) => normalizeTitle(alias) === key));
    return row ? { id: row.id, title: row.title } : null;
  }
  return queryOne<NoteRef>(
    `SELECT id,title FROM notes WHERE deleted_at IS NULL AND
     (lower(trim(regexp_replace(title, '[[:space:]]+', ' ', 'g')))=$1
      OR EXISTS (SELECT 1 FROM unnest(aliases) alias
        WHERE lower(trim(regexp_replace(alias, '[[:space:]]+', ' ', 'g')))=$1))
     ORDER BY created_at LIMIT 1`,
    [key],
  );
}
