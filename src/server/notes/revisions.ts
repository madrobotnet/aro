import type { QueryResultRow } from "pg";
import type { NoteRevision, NoteRevisionSummary, RevisionReason } from "@/lib/note-revisions";
import { excerpt } from "@/lib/wikilinks";
import { query, queryOne } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { notesCopy } from "@/server/i18n/copy";
import { assertNoteId, updateNote, type NoteDetail } from "./service";

type SummaryRow = QueryResultRow & {
  id: string; created_at: Date; reason: RevisionReason; title: string; head: string; body_length: number;
};
type RevisionRow = QueryResultRow & {
  id: string; note_id: string; created_at: Date; reason: RevisionReason;
  title: string; body: string; tags: string[]; aliases: string[];
};

async function assertNoteExists(noteId: string): Promise<void> {
  assertNoteId(noteId);
  if (!(await queryOne("SELECT 1 FROM notes WHERE id=$1", [noteId]))) throw new ApiError("not_found", notesCopy.notFound);
}

export async function listRevisions(noteId: string): Promise<NoteRevisionSummary[]> {
  if (databaseBackend() === "sqlite") {
    const { listSQLiteRevisions } = await import("./sqlite");
    return listSQLiteRevisions(await sqliteStore(), noteId);
  }
  await assertNoteExists(noteId);
  const rows = await query<SummaryRow>(
    `SELECT id,created_at,reason,title,left(body,2000) AS head,char_length(body)::int AS body_length
       FROM note_revisions WHERE note_id=$1 ORDER BY created_at DESC,id DESC`,
    [noteId],
  );
  return rows.map((row) => ({
    id: row.id, createdAt: row.created_at.toISOString(), reason: row.reason, title: row.title,
    bodyLength: row.body_length, excerpt: excerpt(row.head, 160),
  }));
}

export async function getRevision(noteId: string, revisionId: string): Promise<NoteRevision> {
  if (databaseBackend() === "sqlite") {
    const { getSQLiteRevision } = await import("./sqlite");
    return getSQLiteRevision(await sqliteStore(), noteId, revisionId);
  }
  await assertNoteExists(noteId);
  assertNoteId(revisionId);
  const row = await queryOne<RevisionRow>("SELECT * FROM note_revisions WHERE id=$1 AND note_id=$2", [revisionId, noteId]);
  if (!row) throw new ApiError("not_found", notesCopy.revisionNotFound);
  return {
    id: row.id, noteId: row.note_id, createdAt: row.created_at.toISOString(), reason: row.reason,
    title: row.title, body: row.body, tags: row.tags, aliases: row.aliases,
  };
}

/** Restores through updateNote so links, search, and a pre-restore snapshot stay consistent. */
export async function restoreRevision(noteId: string, revisionId: string): Promise<NoteDetail> {
  const revision = await getRevision(noteId, revisionId);
  return updateNote(noteId, {
    title: revision.title, body: revision.body, tags: revision.tags, aliases: revision.aliases,
  }, { reason: "restore" });
}
