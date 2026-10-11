import { createHash } from "node:crypto";
import type { Locale } from "@/lib/i18n/locale";
import type { NoteRevision, NoteRevisionSummary, RevisionReason } from "@/lib/note-revisions";
import { linkFirstMention } from "@/lib/link-mention";
import { renderTemplate } from "@/lib/templates";
import type { Note, NoteLinks, NoteListItem, NoteTitleMatch, TagCount } from "@/lib/types";
import { excerpt, linkTargets, markdownToText, mergeTags, normalizeTitle, parseInlineTags, parseWikiLinks } from "@/lib/wikilinks";
import { embedText } from "@/lib/embed";
import { readSQLiteBoolean, readSQLiteStringArray, sqliteStringArray, sqliteTimestamp, sqliteUuid, type SQLiteExecutor } from "@/server/db/sqlite";
import { ApiError } from "@/server/http";
import { notesCopy, UNTITLED, untitledCandidate } from "@/server/i18n/copy";
import { storagePath } from "./attachment-storage";
import { REVISION_LIMIT, type RevisionContent } from "./revision-store";
import { assertNoteId, type CreateNoteInput, type ListNotesInput, type PurgeScope, type UpdateNoteInput } from "./service";

type NoteRow = {
  id: string; title: string; body: string; tags: string; aliases: string; pinned: bigint;
  status: string; source_url: string | null; daily_date: string | null;
  created_at: string; updated_at: string; deleted_at: string | null; purge_at: string | null;
};
type RevisionRow = {
  id: string; note_id: string; title: string; body: string; tags: string; aliases: string;
  reason: RevisionReason; created_at: string;
};
const iso = (instant: string): string => new Date(instant).toISOString();
const now = (): string => sqliteTimestamp(new Date());
const before = (instant: string, milliseconds: number): string => sqliteTimestamp(new Date(Date.parse(instant) - milliseconds));
const DAYS_30 = 30 * 86400_000;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const newest = (a: NoteRow, b: NoteRow): number => compare(b.updated_at, a.updated_at) || compare(b.id, a.id);
function identity(id: string): string { assertNoteId(id); return sqliteUuid(id); }
function required(q: SQLiteExecutor, id: string): NoteRow {
  const row = q.get<NoteRow>("SELECT * FROM notes WHERE id=?", [identity(id)]);
  if (!row) throw new ApiError("not_found", notesCopy.notFound);
  return row;
}
function content(row: Pick<NoteRow, "title" | "body" | "tags" | "aliases">): { title: string; body: string; tags: string[]; aliases: string[] } {
  return { title: row.title, body: row.body, tags: readSQLiteStringArray(row.tags), aliases: readSQLiteStringArray(row.aliases) };
}
function mapNote(row: NoteRow): Note {
  return {
    id: row.id, ...content(row), excerpt: excerpt(row.body), pinned: readSQLiteBoolean(row.pinned),
    archived: row.status === "archived", sourceUrl: row.source_url, dailyDate: row.daily_date,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    deletedAt: row.deleted_at ? iso(row.deleted_at) : null, purgeAt: row.purge_at ? iso(row.purge_at) : null,
  };
}
function summary(row: NoteRow): NoteListItem {
  const note = mapNote(row);
  return {
    id: note.id, title: note.title, excerpt: note.excerpt, tags: note.tags, pinned: note.pinned,
    archived: note.archived, dailyDate: note.dailyDate, createdAt: note.createdAt,
    updatedAt: note.updatedAt, purgeAt: note.purgeAt,
  };
}
function aliases(values: readonly string[]): string[] {
  const names = new Map<string, string>();
  for (const value of values) {
    const name = value.trim().replace(/\s+/g, " ");
    if (name) names.set(normalizeTitle(name), name);
  }
  return [...names.values()];
}
function active(q: SQLiteExecutor): NoteRow[] {
  return q.all<NoteRow>("SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at,id");
}
function matches(row: NoteRow, key: string): boolean {
  return normalizeTitle(row.title) === key || readSQLiteStringArray(row.aliases).some((name) => normalizeTitle(name) === key);
}

/** Unicode matching is performed by the same normalizer as the wikilink parser, not SQLite lower(). */
export function materializeSQLiteLinks(q: SQLiteExecutor, noteId: string, body: string): void {
  const id = identity(noteId);
  q.run("DELETE FROM links WHERE from_note_id=? AND relation='link'", [id]);
  q.run("DELETE FROM unresolved_links WHERE from_note_id=?", [id]);
  const candidates = active(q).filter((row) => row.id !== id);
  for (const target of linkTargets(body)) {
    const key = normalizeTitle(target);
    const resolved = candidates.find((row) => normalizeTitle(row.title) === key) ?? candidates.find((row) => matches(row, key));
    if (resolved) q.run("INSERT INTO links(from_note_id,to_note_id,relation) VALUES (?,?,'link') ON CONFLICT DO NOTHING", [id, resolved.id]);
    else q.run("INSERT INTO unresolved_links(from_note_id,target_title) VALUES (?,?) ON CONFLICT DO NOTHING", [id, target]);
  }
}
function resolve(q: SQLiteExecutor, id: string, names: readonly string[]): void {
  const keys = new Set(names.map(normalizeTitle).filter(Boolean));
  const pending = q.all<{ from_note_id: string; target_title: string }>(
    "SELECT u.* FROM unresolved_links u JOIN notes n ON n.id=u.from_note_id WHERE n.deleted_at IS NULL",
  );
  for (const row of pending) {
    if (row.from_note_id === id || !keys.has(normalizeTitle(row.target_title))) continue;
    q.run("INSERT INTO links(from_note_id,to_note_id,relation) VALUES (?,?,'link') ON CONFLICT DO NOTHING", [row.from_note_id, id]);
    q.run("DELETE FROM unresolved_links WHERE from_note_id=? AND target_title=?", [row.from_note_id, row.target_title]);
  }
}
function cache(title: string, body: string): [string, string] {
  return [JSON.stringify(embedText(`${title}\n${body}`)), createHash("md5").update(`${title}\n${body}`).digest("hex")];
}

/** Synchronous composition seam for import/inbox callers already inside store.transaction(). */
export function createSQLiteNote(q: SQLiteExecutor, input: CreateNoteInput, locale: Locale = "ko", dailyDate: string | null = null): Note {
  let title = input.title?.trim() ?? "";
  if (!title) {
    const used = new Set(active(q).map((row) => row.title));
    title = UNTITLED[locale];
    for (let suffix = 2; used.has(title); suffix += 1) title = untitledCandidate(locale, suffix);
  }
  const body = input.body ?? "";
  const instant = now();
  const [embedding, hash] = cache(title, body);
  const row = q.get<NoteRow>(
    `INSERT INTO notes(title,body,tags,source_url,daily_date,search_embedding,search_embedded_at,search_source_hash,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    [title, body, sqliteStringArray(mergeTags(input.tags ?? [], parseInlineTags(body))), input.sourceUrl ?? null,
      dailyDate, embedding, instant, hash, instant, instant],
  );
  if (!row) throw new ApiError("internal", "Note insert did not return a row");
  materializeSQLiteLinks(q, row.id, body);
  resolve(q, row.id, [title]);
  return mapNote(row);
}
export function getSQLiteNote(q: SQLiteExecutor, id: string): Note | null {
  const row = q.get<NoteRow>("SELECT * FROM notes WHERE id=?", [identity(id)]);
  return row ? mapNote(row) : null;
}
const sameContent = (a: RevisionContent, b: RevisionContent): boolean =>
  a.title === b.title && a.body === b.body && JSON.stringify(a.tags) === JSON.stringify(b.tags) && JSON.stringify(a.aliases) === JSON.stringify(b.aliases);

export function recordSQLiteRevision(
  q: SQLiteExecutor, change: { readonly noteId: string; readonly previous: RevisionContent; readonly next: RevisionContent },
  reason: RevisionReason, instant = now(),
): void {
  if (sameContent(change.previous, change.next)) return;
  const id = identity(change.noteId);
  const latest = q.get<RevisionRow>("SELECT * FROM note_revisions WHERE note_id=? ORDER BY created_at DESC,id DESC LIMIT 1", [id]);
  if (latest && (sameContent(content(latest), change.previous) || (reason === "edit" && latest.created_at > before(instant, 600_000)))) return;
  const previous = change.previous;
  q.run("INSERT INTO note_revisions(note_id,title,body,tags,aliases,reason,created_at) VALUES (?,?,?,?,?,?,?)",
    [id, previous.title, previous.body, sqliteStringArray(previous.tags), sqliteStringArray(previous.aliases), reason, instant]);
  q.run(`DELETE FROM note_revisions WHERE id IN (
    SELECT id FROM (SELECT id,created_at,row_number() OVER (ORDER BY created_at DESC,id DESC) AS rank
    FROM note_revisions WHERE note_id=?) WHERE rank>1 AND (rank>? OR created_at<?))`,
  [id, REVISION_LIMIT, before(instant, DAYS_30)]);
}
export function pruneSQLiteRevisions(q: SQLiteExecutor): void {
  q.run(`DELETE FROM note_revisions WHERE created_at<? AND EXISTS (
    SELECT 1 FROM note_revisions newer WHERE newer.note_id=note_revisions.note_id
    AND (newer.created_at,newer.id)>(note_revisions.created_at,note_revisions.id))`, [before(now(), DAYS_30)]);
}
export function updateSQLiteNote(q: SQLiteExecutor, noteId: string, input: UpdateNoteInput, reason: RevisionReason = "edit"): Note {
  const current = required(q, noteId);
  if (current.deleted_at) throw new ApiError("conflict", notesCopy.trashedReadOnly);
  const title = input.title === undefined ? current.title : input.title.trim();
  if (!title) throw new ApiError("validation", notesCopy.titleRequired);
  const previous = content(current);
  const body = input.body ?? current.body;
  const tags = mergeTags(input.tags ?? previous.tags, parseInlineTags(body));
  let names = input.aliases ? aliases(input.aliases) : previous.aliases;
  if (normalizeTitle(title) !== normalizeTitle(current.title)) names = aliases([...names, current.title]);
  names = names.filter((name) => normalizeTitle(name) !== normalizeTitle(title));
  const instant = now();
  recordSQLiteRevision(q, { noteId: current.id, previous, next: { title, body, tags, aliases: names } }, reason, instant);
  const [embedding, hash] = cache(title, body);
  q.run(`UPDATE notes SET title=?,body=?,tags=?,aliases=?,pinned=?,status=?,search_embedding=?,
    search_embedded_at=?,search_source_hash=?,updated_at=? WHERE id=?`,
  [title, body, sqliteStringArray(tags), sqliteStringArray(names), input.pinned === undefined ? current.pinned : Number(input.pinned),
    input.archived === undefined ? current.status : input.archived ? "archived" : "draft",
    embedding, instant, hash, instant, current.id]);
  materializeSQLiteLinks(q, current.id, body);
  resolve(q, current.id, [title, ...names]);
  return mapNote(required(q, current.id));
}
function sources(q: SQLiteExecutor, id: string): { id: string; body: string }[] {
  return q.all("SELECT n.id,n.body FROM links l JOIN notes n ON n.id=l.from_note_id WHERE l.to_note_id=? AND n.deleted_at IS NULL", [id]);
}
export function trashSQLiteNote(q: SQLiteExecutor, noteId: string): Note {
  const current = required(q, noteId);
  const incoming = sources(q, current.id);
  const instant = now();
  q.run("UPDATE notes SET deleted_at=coalesce(deleted_at,?),purge_at=coalesce(purge_at,?),updated_at=? WHERE id=?",
    [instant, sqliteTimestamp(new Date(Date.parse(instant) + DAYS_30)), instant, current.id]);
  for (const source of incoming) materializeSQLiteLinks(q, source.id, source.body);
  return mapNote(required(q, current.id));
}
export function restoreSQLiteNote(q: SQLiteExecutor, noteId: string): Note {
  const row = q.get<NoteRow>("SELECT * FROM notes WHERE id=? AND deleted_at IS NOT NULL", [identity(noteId)]);
  if (!row) throw new ApiError("not_found", notesCopy.notInTrash);
  if (row.daily_date && q.get("SELECT id FROM notes WHERE daily_date=? AND deleted_at IS NULL", [row.daily_date])) {
    throw new ApiError("conflict", notesCopy.dailyConflict);
  }
  q.run("UPDATE notes SET deleted_at=NULL,purge_at=NULL,updated_at=? WHERE id=?", [now(), row.id]);
  materializeSQLiteLinks(q, row.id, row.body);
  resolve(q, row.id, [row.title, ...readSQLiteStringArray(row.aliases)]);
  return mapNote(required(q, row.id));
}
/** Enqueues keys inside the writer transaction; filesystem cleanup belongs after commit. */
export function purgeSQLiteNote(q: SQLiteExecutor, noteId: string, scope: PurgeScope): boolean {
  const id = identity(noteId);
  if (!q.get("SELECT id FROM notes WHERE id=? AND deleted_at IS NOT NULL AND (?='trashed' OR purge_at<=?)", [id, scope, now()])) return false;
  const incoming = sources(q, id);
  const candidates = q.all<NoteRow>("SELECT * FROM notes WHERE id<>?", [id])
    .sort((a, b) => Number(a.deleted_at !== null) - Number(b.deleted_at !== null) || compare(b.updated_at, a.updated_at) || compare(a.id, b.id));
  for (const attachment of q.all<{ id: string; storage_key: string }>("SELECT id,storage_key FROM attachments WHERE note_id=?", [id])) {
    const replacement = candidates.find((row) => row.body.toLowerCase().includes(`/api/attachments/${attachment.id}`));
    if (replacement) q.run("UPDATE attachments SET note_id=? WHERE id=?", [replacement.id, attachment.id]);
    else {
      storagePath(attachment.storage_key);
      q.run("INSERT INTO attachment_cleanup(storage_key) VALUES (?) ON CONFLICT DO NOTHING", [attachment.storage_key]);
      q.run("DELETE FROM attachments WHERE id=?", [attachment.id]);
    }
  }
  q.run("DELETE FROM notes WHERE id=?", [id]);
  for (const source of incoming) materializeSQLiteLinks(q, source.id, source.body);
  return true;
}
// SQL LIKE wildcards retain their public meaning while case folding covers Unicode.
function like(value: string, pattern: string): boolean {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      expression += pattern[index]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "%") expression += "[\\s\\S]*";
    else if (char === "_") expression += "[\\s\\S]";
    else expression += char?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`, "u").test(value.toLowerCase());
}
export function listSQLiteNotes(q: SQLiteExecutor, input: ListNotesInput): { notes: NoteListItem[]; nextCursor: string | null } {
  let cursor: { updatedAt: string; id: string } | null = null;
  if (input.cursor) {
    try {
      const parsed: { updatedAt?: unknown; id?: unknown } = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") throw new ApiError("validation", notesCopy.badCursor);
      cursor = { updatedAt: sqliteTimestamp(parsed.updatedAt), id: identity(parsed.id) };
    } catch { throw new ApiError("validation", notesCopy.badCursor); }
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const rows = q.all<NoteRow>("SELECT * FROM notes").filter((row) => {
    if (input.trash ? !row.deleted_at : row.deleted_at) return false;
    if (input.archived ? row.status !== "archived" : !input.trash && row.status === "archived") return false;
    if (input.pinned && !readSQLiteBoolean(row.pinned)) return false;
    if (input.q && ![row.title, row.body].some((value) => like(value, `%${input.q?.toLowerCase()}%`))) return false;
    if (input.tag && !readSQLiteStringArray(row.tags).includes(input.tag.toLowerCase())) return false;
    return !cursor || row.updated_at < cursor.updatedAt || (row.updated_at === cursor.updatedAt && row.id < cursor.id);
  }).sort(newest);
  const page = rows.slice(0, limit);
  const tail = page.at(-1);
  return {
    notes: page.map(summary),
    nextCursor: rows.length > limit && tail ? Buffer.from(JSON.stringify({ updatedAt: tail.updated_at, id: tail.id })).toString("base64url") : null,
  };
}
// Native word trigram sets provide the existing autocomplete similarity tie-breaker.
function similarity(left: string, right: string): number {
  const grams = (value: string): Set<string> => {
    const out = new Set<string>();
    for (const word of value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      const chars = Array.from(`  ${word} `);
      for (let i = 0; i + 2 < chars.length; i += 1) out.add(chars.slice(i, i + 3).join(""));
    }
    return out;
  };
  const a = grams(left); const b = grams(right);
  const overlap = [...a].filter((gram) => b.has(gram)).length;
  return overlap / (a.size + b.size - overlap || 1);
}
export function findSQLiteNoteTitles(q: SQLiteExecutor, text = "", limit = 10): NoteTitleMatch[] {
  const key = text.toLowerCase(); const pattern = `%${key}%`;
  return active(q).filter((row) => row.status !== "archived").flatMap((row) => {
    const names = readSQLiteStringArray(row.aliases);
    const titleMatch = like(row.title, pattern);
    const matched = names.filter((name) => like(name, pattern)).sort((a, b) =>
      Number(b.toLowerCase() === key) - Number(a.toLowerCase() === key) || similarity(b, text) - similarity(a, text));
    if (!titleMatch && matched.length === 0) return [];
    return [{ row, exact: row.title.toLowerCase() === key || names.some((name) => name.toLowerCase() === key),
      matchedAlias: titleMatch ? null : matched[0] ?? null }];
  }).sort((a, b) => Number(b.exact) - Number(a.exact) || similarity(b.row.title, text) - similarity(a.row.title, text) || newest(a.row, b.row))
    .slice(0, Math.min(Math.max(limit, 1), 50)).map(({ row, matchedAlias }) => ({ id: row.id, title: row.title, matchedAlias }));
}
export function getOrCreateSQLiteByTitle(q: SQLiteExecutor, titleInput: string): Note {
  const title = titleInput.trim();
  if (!title) throw new ApiError("validation", notesCopy.titleRequired);
  const row = active(q).find((candidate) => matches(candidate, normalizeTitle(title)));
  return row ? mapNote(row) : createSQLiteNote(q, { title });
}
export function getOrCreateSQLiteDaily(q: SQLiteExecutor, date: string): Note {
  const row = q.get<NoteRow>("SELECT * FROM notes WHERE daily_date=? AND deleted_at IS NULL", [date]);
  if (row) return mapNote(row);
  const template = q.get<{ body: string }>("SELECT body FROM note_templates WHERE is_daily_default=1 LIMIT 1");
  return createSQLiteNote(q, { title: date, body: template ? renderTemplate(template.body, { date, title: date }) : "" }, "ko", date);
}
export function getSQLiteNoteLinks(q: SQLiteExecutor, noteId: string): NoteLinks {
  const note = required(q, noteId);
  const names = [note.title, ...readSQLiteStringArray(note.aliases)];
  const context = (row: { id: string; title: string; body: string }) => {
    const link = parseWikiLinks(row.body).find((item) => names.some((name) => normalizeTitle(name) === normalizeTitle(item.target)));
    const plainIndex = names.reduce((found, name) => {
      const index = row.body.toLowerCase().indexOf(name.toLowerCase());
      return index >= 0 && (found < 0 || index < found) ? index : found;
    }, -1);
    const position = link?.start ?? Math.max(0, plainIndex);
    return { id: row.id, title: row.title, context: markdownToText(row.body.slice(Math.max(0, position - 100), position + 180)).slice(0, 240) };
  };
  const outgoing = q.all<{ id: string; title: string }>(
    "SELECT n.id,n.title FROM links l JOIN notes n ON n.id=l.to_note_id WHERE l.from_note_id=? AND n.deleted_at IS NULL ORDER BY n.title", [note.id]);
  const incoming = sources(q, note.id);
  const backlinkIds = new Set(incoming.map((row) => row.id));
  const backlinks = active(q).filter((row) => backlinkIds.has(row.id)).sort(newest);
  const mentions = active(q).filter((row) => row.id !== note.id && !backlinkIds.has(row.id)
    && names.some((name) => like(row.body, `%${name.toLowerCase()}%`))).sort(newest).slice(0, 50);
  return { outgoing, backlinks: backlinks.map(context), unlinkedMentions: mentions.map(context),
    unresolved: q.all<{ target_title: string }>("SELECT target_title FROM unresolved_links WHERE from_note_id=? ORDER BY target_title", [note.id]).map((row) => row.target_title) };
}
export function listSQLiteTags(q: SQLiteExecutor): TagCount[] {
  const counts = new Map<string, number>();
  for (const row of active(q)) for (const tag of readSQLiteStringArray(row.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || compare(a.tag, b.tag));
}
export function listSQLiteRevisions(q: SQLiteExecutor, noteId: string): NoteRevisionSummary[] {
  const note = required(q, noteId);
  return q.all<RevisionRow>("SELECT * FROM note_revisions WHERE note_id=? ORDER BY created_at DESC,id DESC", [note.id]).map((row) => ({
    id: row.id, createdAt: iso(row.created_at), reason: row.reason, title: row.title,
    bodyLength: Array.from(row.body).length, excerpt: excerpt(Array.from(row.body).slice(0, 2000).join(""), 160),
  }));
}
export function getSQLiteRevision(q: SQLiteExecutor, noteId: string, revisionId: string): NoteRevision {
  const note = required(q, noteId);
  const row = q.get<RevisionRow>("SELECT * FROM note_revisions WHERE id=? AND note_id=?", [identity(revisionId), note.id]);
  if (!row) throw new ApiError("not_found", notesCopy.revisionNotFound);
  return { id: row.id, noteId: row.note_id, createdAt: iso(row.created_at), reason: row.reason, ...content(row) };
}
export function linkSQLiteMention(q: SQLiteExecutor, input: { targetId: string; sourceId: string; expectedUpdatedAt: string }): Note {
  if (identity(input.targetId) === identity(input.sourceId)) throw new ApiError("validation", notesCopy.mentionSelf);
  const target = required(q, input.targetId); const source = required(q, input.sourceId);
  if (target.deleted_at) throw new ApiError("conflict", notesCopy.mentionTargetTrashed);
  if (source.deleted_at) throw new ApiError("conflict", notesCopy.trashedReadOnly);
  if (iso(source.updated_at) !== new Date(input.expectedUpdatedAt).toISOString()) throw new ApiError("conflict", notesCopy.staleNote, { conflict: "stale" });
  const body = linkFirstMention(source.body, { title: target.title, aliases: readSQLiteStringArray(target.aliases) });
  if (body === null) throw new ApiError("conflict", notesCopy.mentionGone, { conflict: "mention_gone" });
  return updateSQLiteNote(q, source.id, { body }, "link-mention");
}
