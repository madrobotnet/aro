import { Database } from "bun:sqlite";
import { sqliteStore } from "@/server/db/backend";
import { readSQLiteBoolean, readSQLiteStringArray } from "@/server/db/sqlite";
import type { AttachmentRow, ExportSnapshot, NoteRow } from "./service";

type SQLiteNote = Omit<NoteRow, "tags" | "aliases" | "pinned" | "created_at" | "updated_at" | "cursor"> & {
  tags: string; aliases: string; pinned: bigint; created_at: string; updated_at: string;
};
const REFERENCE = /\/api\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Separate reader: the app's synchronous writer is never held across stream awaits. */
export async function sqliteExportSnapshot(): Promise<ExportSnapshot> {
  await sqliteStore(); // Initialize/verify the owned store before opening the read-only handle.
  const reader = new Database(process.env.ARO_SQLITE_PATH, { readonly: true, strict: true, safeIntegers: true });
  const close = () => {
    try {
      reader.run("ROLLBACK");
    } finally {
      reader.close(true);
    }
  };
  try {
    reader.run("BEGIN");
    // BEGIN is deferred; the first SELECT in metadata establishes the WAL snapshot.
  } catch (error) {
    reader.close(true);
    throw error;
  }
  return {
    async metadata() {
      using names = reader.query<{ id: string; title: string; aliases: string }, []>(
        "SELECT id,title,aliases FROM notes WHERE deleted_at IS NULL ORDER BY created_at,id",
      );
      const notes = names.all().map((row) => ({ ...row, aliases: readSQLiteStringArray(row.aliases) }));
      const references = new Set<string>();
      // Only one body is retained while discovering linked attachments; never all bodies.
      using bodies = reader.query<{ body: string }, []>("SELECT body FROM notes WHERE deleted_at IS NULL");
      for (const { body } of bodies.iterate()) {
        for (const match of body.matchAll(REFERENCE)) {
          const id = match[1];
          if (id) references.add(id.toLowerCase());
        }
      }
      using files = reader.query<{
        id: string; filename: string; storage_key: string; created_at: string; exported: bigint;
      }, []>(`SELECT a.id,a.filename,a.storage_key,a.created_at,
        EXISTS(SELECT 1 FROM notes n WHERE n.id=a.note_id AND n.deleted_at IS NULL) AS exported
        FROM attachments a ORDER BY a.created_at,a.id`);
      const attachments: AttachmentRow[] = [];
      for (const row of files.iterate()) {
        const linked = references.delete(row.id);
        if (readSQLiteBoolean(row.exported) || linked) {
          attachments.push({ ...row, created_at: new Date(row.created_at) });
        }
      }
      return { notes, attachments, missing: [...references].map((id) => ({ id })) };
    },
    async *notes() {
      using rows = reader.query<SQLiteNote, []>(
        `SELECT id,title,body,tags,aliases,pinned,status,source_url,daily_date,created_at,updated_at
         FROM notes WHERE deleted_at IS NULL ORDER BY created_at,id`,
      );
      for (const row of rows.iterate()) {
        yield {
          ...row, tags: readSQLiteStringArray(row.tags), aliases: readSQLiteStringArray(row.aliases),
          pinned: readSQLiteBoolean(row.pinned), created_at: new Date(row.created_at),
          updated_at: new Date(row.updated_at), cursor: row.created_at,
        };
      }
    },
    close,
  };
}
