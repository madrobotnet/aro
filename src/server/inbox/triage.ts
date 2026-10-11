import type { PoolClient } from "pg";
import { stripInboxUrlStatus } from "@/lib/inbox-url-status";
import { query, tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { inboxCopy, notesCopy } from "@/server/i18n/copy";
import { assertNoteId, updateNote, type NoteDetail } from "@/server/notes/service";
import { assertInboxId, mapItem, type InboxItemDto, type InboxRow } from "./service";
import { mergeSQLiteInbox, restoreSQLiteInbox, snoozeSQLiteInbox } from "./sqlite";

export type MergeInboxInput = { noteId: string; expectedUpdatedAt?: string };

async function lockItem(client: PoolClient, id: string): Promise<InboxRow> {
  const item = (await client.query<InboxRow>("SELECT * FROM inbox_items WHERE id=$1 FOR UPDATE", [id])).rows[0];
  if (!item) throw new ApiError("not_found", inboxCopy.notFound);
  return item;
}

export async function restoreInbox(id: string): Promise<InboxItemDto> {
  assertInboxId(id);
  if (databaseBackend() === "sqlite") return (await sqliteStore()).transaction((q) => restoreSQLiteInbox(q, id));
  return tx(async (client) => {
    const item = await lockItem(client, id);
    if (item.promoted_note_id) throw new ApiError("conflict", inboxCopy.alreadyPromoted);
    const result = await client.query<InboxRow>("UPDATE inbox_items SET discarded_at=NULL WHERE id=$1 RETURNING *", [id]);
    return mapItem(result.rows[0]!);
  });
}

export async function snoozeInbox(id: string, until: Date, now = new Date()): Promise<InboxItemDto> {
  assertInboxId(id);
  const limit = new Date(now);
  limit.setUTCFullYear(limit.getUTCFullYear() + 1);
  if (until.getTime() <= now.getTime()) throw new ApiError("validation", inboxCopy.snoozePast);
  if (until.getTime() > limit.getTime()) throw new ApiError("validation", inboxCopy.snoozeTooFar);
  if (databaseBackend() === "sqlite") return (await sqliteStore()).transaction((q) => snoozeSQLiteInbox(q, id, until));
  return tx(async (client) => {
    const item = await lockItem(client, id);
    if (item.discarded_at || item.promoted_note_id) throw new ApiError("conflict", inboxCopy.snoozeClosed);
    const result = await client.query<InboxRow>(
      "UPDATE inbox_items SET snoozed_until=$2 WHERE id=$1 RETURNING *", [id, until.toISOString()],
    );
    return mapItem(result.rows[0]!);
  });
}

export async function unsnoozeInbox(id: string): Promise<InboxItemDto> {
  assertInboxId(id);
  if (databaseBackend() === "sqlite") return (await sqliteStore()).transaction((q) => snoozeSQLiteInbox(q, id, null));
  const [row] = await query<InboxRow>("UPDATE inbox_items SET snoozed_until=NULL WHERE id=$1 RETURNING *", [id]);
  if (!row) throw new ApiError("not_found", inboxCopy.notFound);
  return mapItem(row);
}

function mergedBody(noteBody: string, item: InboxRow): string {
  const text = stripInboxUrlStatus(item.body) || item.title;
  const block = item.url && !text.includes(item.url) ? `${text}\n\n${item.url}` : text;
  const base = noteBody.trimEnd();
  return base ? `${base}\n\n---\n\n${block}` : block;
}

/** Append an inbox item to an existing note, move its attachments, and close it, atomically. */
export async function mergeInbox(id: string, input: MergeInboxInput): Promise<NoteDetail> {
  assertInboxId(id);
  assertNoteId(input.noteId);
  if (databaseBackend() === "sqlite") return (await sqliteStore()).transaction((q) => mergeSQLiteInbox(q, id, input));
  return tx(async (client) => {
    const item = await lockItem(client, id);
    if (item.discarded_at) throw new ApiError("conflict", inboxCopy.mergeDiscarded);
    if (item.promoted_note_id) throw new ApiError("conflict", inboxCopy.alreadyPromoted);
    const note = (await client.query<{ body: string; deleted_at: Date | null; updated_at: Date }>(
      "SELECT body,deleted_at,updated_at FROM notes WHERE id=$1 FOR UPDATE", [input.noteId],
    )).rows[0];
    if (!note) throw new ApiError("not_found", notesCopy.notFound);
    if (note.deleted_at) throw new ApiError("conflict", notesCopy.trashedReadOnly);
    const expected = input.expectedUpdatedAt;
    if (expected !== undefined && note.updated_at.toISOString() !== new Date(expected).toISOString()) {
      throw new ApiError("conflict", notesCopy.staleNote, { conflict: "stale" });
    }
    const merged = await updateNote(input.noteId, { body: mergedBody(note.body, item) }, { reason: "merge", client });
    await client.query("UPDATE attachments SET note_id=$2,inbox_item_id=NULL WHERE inbox_item_id=$1", [id, input.noteId]);
    await client.query("UPDATE inbox_items SET promoted_note_id=$2,snoozed_until=NULL WHERE id=$1", [id, input.noteId]);
    return merged;
  });
}
