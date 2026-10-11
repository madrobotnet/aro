import type { QueryResultRow } from "pg";
import { linkFirstMention } from "@/lib/link-mention";
import { tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { notesCopy } from "@/server/i18n/copy";
import { assertNoteId, updateNote, type NoteDetail } from "./service";

type MentionRow = QueryResultRow & {
  title: string; body: string; aliases: string[]; deleted_at: Date | null; updated_at: Date;
};

export type LinkMentionInput = { targetId: string; sourceId: string; expectedUpdatedAt: string };

/** Turn the first unlinked mention of the target inside the source note into a wikilink. */
export async function linkMention(input: LinkMentionInput): Promise<NoteDetail> {
  if (databaseBackend() === "sqlite") {
    const { linkSQLiteMention } = await import("./sqlite");
    return (await sqliteStore()).transaction((q) => linkSQLiteMention(q, input));
  }
  const { targetId, sourceId } = input;
  assertNoteId(targetId);
  assertNoteId(sourceId);
  if (targetId === sourceId) throw new ApiError("validation", notesCopy.mentionSelf);
  return tx(async (client) => {
    const target = (await client.query<MentionRow>("SELECT * FROM notes WHERE id=$1", [targetId])).rows[0];
    if (!target) throw new ApiError("not_found", notesCopy.notFound);
    if (target.deleted_at) throw new ApiError("conflict", notesCopy.mentionTargetTrashed);
    const source = (await client.query<MentionRow>("SELECT * FROM notes WHERE id=$1 FOR UPDATE", [sourceId])).rows[0];
    if (!source) throw new ApiError("not_found", notesCopy.notFound);
    if (source.deleted_at) throw new ApiError("conflict", notesCopy.trashedReadOnly);
    if (source.updated_at.toISOString() !== new Date(input.expectedUpdatedAt).toISOString()) {
      throw new ApiError("conflict", notesCopy.staleNote, { conflict: "stale" });
    }
    const body = linkFirstMention(source.body, { title: target.title, aliases: target.aliases });
    if (body === null) throw new ApiError("conflict", notesCopy.mentionGone, { conflict: "mention_gone" });
    return updateNote(sourceId, { body }, { reason: "link-mention", client });
  });
}
