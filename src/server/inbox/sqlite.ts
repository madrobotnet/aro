import type { Locale } from "@/lib/i18n/locale";
import { stripInboxUrlStatus } from "@/lib/inbox-url-status";
import type { Note } from "@/lib/types";
import { readSQLiteNumber, sqliteTimestamp, sqliteUuid, type SQLiteExecutor, type SQLiteStore } from "@/server/db/sqlite";
import { ApiError } from "@/server/http";
import { inboxCopy, notesCopy } from "@/server/i18n/copy";
import { createSQLiteNote, getSQLiteNote, updateSQLiteNote } from "@/server/notes/sqlite";
import { assertInboxId, mapItem, type InboxRow, type InboxList, type InboxView, type PromoteInboxInput } from "./service";
import type { MergeInboxInput } from "./triage";

type StoredInboxRow = Pick<InboxRow, "id" | "title" | "body" | "source" | "url" | "promoted_note_id"
  | "discarded_at" | "created_at" | "snoozed_until"> & { suggestions: string | null };
export function sqliteInboxRow(q: SQLiteExecutor, id: string): InboxRow | null {
  assertInboxId(id);
  const row = q.get<StoredInboxRow>("SELECT * FROM inbox_items WHERE id=?", [sqliteUuid(id)]);
  return row ? decode(row) : null;
}
function decode(row: StoredInboxRow): InboxRow {
  return { ...row, suggestions: row.suggestions === null ? null : JSON.parse(row.suggestions) };
}
function required(q: SQLiteExecutor, id: string): InboxRow {
  const item = sqliteInboxRow(q, id);
  if (!item) throw new ApiError("not_found", inboxCopy.notFound);
  return item;
}
const OPEN = "discarded_at IS NULL AND promoted_note_id IS NULL";
export function listSQLiteInbox(q: SQLiteExecutor, view: InboxView): InboxList {
  const instant = sqliteTimestamp(new Date());
  const rows = q.all<StoredInboxRow>(view === "open"
    ? `SELECT * FROM inbox_items WHERE ${OPEN} AND (snoozed_until IS NULL OR snoozed_until<=?) ORDER BY created_at DESC,id DESC`
    : `SELECT * FROM inbox_items WHERE ${OPEN} AND snoozed_until>? ORDER BY snoozed_until,id`, [instant]);
  const snoozed = q.get<{ count: bigint; next: string | null }>(
    `SELECT count(*) AS count,min(snoozed_until) AS next FROM inbox_items WHERE ${OPEN} AND snoozed_until>?`, [instant]);
  return { items: rows.map((row) => mapItem(decode(row))), count: rows.length,
    snoozedCount: snoozed ? readSQLiteNumber(snoozed.count) : 0,
    nextReturnAt: snoozed?.next ? new Date(snoozed.next).toISOString() : null };
}
export function promoteSQLiteInbox(store: SQLiteStore, id: string, input: PromoteInboxInput, locale: Locale): Note {
  return store.transaction((q) => {
    const item = required(q, id);
    if (item.discarded_at) throw new ApiError("conflict", inboxCopy.discarded);
    if (item.promoted_note_id) {
      const note = getSQLiteNote(q, item.promoted_note_id);
      if (!note) throw new ApiError("not_found", inboxCopy.promotedMissing);
      return note;
    }
    const note = createSQLiteNote(q, { title: input.title?.trim() || item.title,
      body: input.body ?? stripInboxUrlStatus(item.body), tags: input.tags, sourceUrl: item.url }, locale);
    q.run("UPDATE inbox_items SET promoted_note_id=? WHERE id=?", [note.id, item.id]);
    q.run("UPDATE attachments SET note_id=?,inbox_item_id=NULL WHERE inbox_item_id=?", [note.id, item.id]);
    return note;
  });
}
export function discardSQLiteInbox(q: SQLiteExecutor, id: string): void {
  const item = required(q, id);
  if (item.promoted_note_id) throw new ApiError("conflict", inboxCopy.alreadyPromoted);
  q.run("UPDATE inbox_items SET discarded_at=coalesce(discarded_at,?) WHERE id=?", [sqliteTimestamp(new Date()), item.id]);
}
export function restoreSQLiteInbox(q: SQLiteExecutor, id: string) {
  const item = required(q, id);
  if (item.promoted_note_id) throw new ApiError("conflict", inboxCopy.alreadyPromoted);
  q.run("UPDATE inbox_items SET discarded_at=NULL WHERE id=?", [item.id]);
  return mapItem(item);
}
export function snoozeSQLiteInbox(q: SQLiteExecutor, id: string, until: Date | null) {
  const item = required(q, id);
  if (until && (item.discarded_at || item.promoted_note_id)) throw new ApiError("conflict", inboxCopy.snoozeClosed);
  const instant = until ? sqliteTimestamp(until) : null;
  q.run("UPDATE inbox_items SET snoozed_until=? WHERE id=?", [instant, item.id]);
  return mapItem({ ...item, snoozed_until: instant });
}
export function mergeSQLiteInbox(q: SQLiteExecutor, id: string, input: MergeInboxInput): Note {
  const item = required(q, id);
  if (item.discarded_at) throw new ApiError("conflict", inboxCopy.mergeDiscarded);
  if (item.promoted_note_id) throw new ApiError("conflict", inboxCopy.alreadyPromoted);
  const note = getSQLiteNote(q, input.noteId);
  if (!note) throw new ApiError("not_found", notesCopy.notFound);
  if (note.deletedAt) throw new ApiError("conflict", notesCopy.trashedReadOnly);
  if (input.expectedUpdatedAt !== undefined && note.updatedAt !== new Date(input.expectedUpdatedAt).toISOString()) {
    throw new ApiError("conflict", notesCopy.staleNote, { conflict: "stale" });
  }
  const text = stripInboxUrlStatus(item.body) || item.title;
  const block = item.url && !text.includes(item.url) ? `${text}\n\n${item.url}` : text;
  const base = note.body.trimEnd();
  const merged = updateSQLiteNote(q, note.id, { body: base ? `${base}\n\n---\n\n${block}` : block }, "merge");
  q.run("UPDATE attachments SET note_id=?,inbox_item_id=NULL WHERE inbox_item_id=?", [note.id, item.id]);
  q.run("UPDATE inbox_items SET promoted_note_id=?,snoozed_until=NULL WHERE id=?", [note.id, item.id]);
  return merged;
}
