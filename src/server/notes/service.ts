import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { LinkContext, Note, NoteLinks, NoteListItem, NoteRef, NoteTitleMatch, TagCount } from "@/lib/types";
import type { Locale } from "@/lib/i18n/locale";
import type { RevisionReason } from "@/lib/note-revisions";
import { renderTemplate } from "@/lib/templates";
import { embedText, vectorLiteral } from "@/lib/embed";
import {
  excerpt,
  linkTargets,
  markdownToText,
  mergeTags,
  normalizeTitle,
  parseInlineTags,
  parseWikiLinks,
} from "@/lib/wikilinks";
import { db, tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { notesCopy, UNTITLED, untitledCandidate } from "@/server/i18n/copy";
import { defaultDailyTemplateBody } from "@/server/templates/service";
import { storagePath } from "./attachment-storage";
import { retryAttachmentCleanup } from "./attachment-cleanup";
import { recordRevision } from "./revision-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Executor = Pick<PoolClient, "query">;
type NoteRow = QueryResultRow & {
  id: string; title: string; body: string; tags: string[]; aliases: string[];
  pinned: boolean; status: string; source_url: string | null;
  daily_date: string | Date | null; created_at: string | Date; updated_at: string | Date;
  deleted_at: string | Date | null; purge_at: string | Date | null;
};
export type NoteDetail = Note;
export type { NoteListItem, NoteTitleMatch };

export type CreateNoteInput = { title?: string; body?: string; tags?: string[]; sourceUrl?: string | null };
export type UpdateNoteInput = {
  title?: string; body?: string; tags?: string[]; aliases?: string[];
  pinned?: boolean; archived?: boolean;
};
/** `client` joins a caller's transaction; `reason` labels the revision snapshot (default "edit"). */
export type UpdateNoteOptions = { reason?: RevisionReason; client?: PoolClient };
export type PurgeScope = "trashed" | "expired";
export type ListNotesInput = {
  q?: string; tag?: string; pinned?: boolean; archived?: boolean; trash?: boolean;
  limit?: number; cursor?: string;
};

export function assertNoteId(id: string): void {
  if (!UUID_RE.test(id)) throw new ApiError("validation", notesCopy.badUuid);
}
const iso = (value: string | Date): string => new Date(value).toISOString();
function dateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
function mapNote(row: NoteRow): NoteDetail {
  return {
    id: row.id, title: row.title, body: row.body, excerpt: excerpt(row.body), tags: row.tags,
    aliases: row.aliases, pinned: row.pinned, archived: row.status === "archived",
    sourceUrl: row.source_url, dailyDate: dateOnly(row.daily_date), createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at), deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
    purgeAt: row.purge_at ? iso(row.purge_at) : null,
  };
}
function mapSummary(row: NoteRow): NoteListItem {
  const note = mapNote(row);
  return {
    id: note.id, title: note.title, excerpt: note.excerpt, tags: note.tags, pinned: note.pinned,
    archived: note.archived, dailyDate: note.dailyDate, createdAt: note.createdAt, updatedAt: note.updatedAt,
    purgeAt: note.purgeAt,
  };
}
async function executor(client?: PoolClient): Promise<Executor> { return client ?? (await db()); }

async function findTarget(q: Executor, target: string, fromId: string): Promise<{ id: string } | null> {
  const result = await q.query<{ id: string }>(
    `SELECT id FROM notes WHERE deleted_at IS NULL AND id <> $2
       AND (lower(trim(regexp_replace(title, '[[:space:]]+', ' ', 'g'))) = $1 OR EXISTS (
         SELECT 1 FROM unnest(aliases) alias
          WHERE lower(trim(regexp_replace(alias, '[[:space:]]+', ' ', 'g'))) = $1
       ))
     ORDER BY CASE WHEN lower(trim(regexp_replace(title, '[[:space:]]+', ' ', 'g'))) = $1
       THEN 0 ELSE 1 END, created_at LIMIT 1`,
    [normalizeTitle(target), fromId],
  );
  return result.rows[0] ?? null;
}

async function materializeLinks(q: Executor, noteId: string, body: string): Promise<void> {
  await q.query("DELETE FROM links WHERE from_note_id=$1 AND relation='link'", [noteId]);
  await q.query("DELETE FROM unresolved_links WHERE from_note_id=$1", [noteId]);
  for (const target of linkTargets(body)) {
    const resolved = await findTarget(q, target, noteId);
    if (resolved) {
      await q.query(
        "INSERT INTO links (from_note_id,to_note_id,relation) VALUES ($1,$2,'link') ON CONFLICT DO NOTHING",
        [noteId, resolved.id],
      );
    } else {
      await q.query(
        "INSERT INTO unresolved_links (from_note_id,target_title) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [noteId, target],
      );
    }
  }
}

async function resolveTargets(q: Executor, noteId: string, names: readonly string[]): Promise<void> {
  const normalized = [...new Set(names.map(normalizeTitle).filter(Boolean))];
  if (normalized.length === 0) return;
  const result = await q.query<{ from_note_id: string }>(
    `SELECT DISTINCT u.from_note_id FROM unresolved_links u
       JOIN notes source ON source.id=u.from_note_id
      WHERE source.deleted_at IS NULL
        AND lower(trim(regexp_replace(u.target_title, '[[:space:]]+', ' ', 'g')))=ANY($1::text[])`,
    [normalized],
  );
  for (const row of result.rows) {
    if (row.from_note_id === noteId) continue;
    await q.query(
      "INSERT INTO links (from_note_id,to_note_id,relation) VALUES ($1,$2,'link') ON CONFLICT DO NOTHING",
      [row.from_note_id, noteId],
    );
    await q.query(
      `DELETE FROM unresolved_links WHERE from_note_id=$1
        AND lower(trim(regexp_replace(target_title, '[[:space:]]+', ' ', 'g')))=ANY($2::text[])`,
      [row.from_note_id, normalized],
    );
  }
}

// Keep the cache fingerprint identical to PostgreSQL's search backfill check.
const sourceHash = (title: string, body: string): string =>
  createHash("md5").update(`${title}\n${body}`).digest("hex");
function normalizeAliases(values: readonly string[]): string[] {
  const aliases = new Map<string, string>();
  for (const value of values) {
    const alias = value.trim().replace(/\s+/g, " ");
    if (alias) aliases.set(normalizeTitle(alias), alias);
  }
  return [...aliases.values()];
}

async function uniqueUntitled(q: Executor, locale: Locale): Promise<string> {
  const base = UNTITLED[locale];
  await q.query("SELECT pg_advisory_xact_lock(hashtextextended('notes:untitled',0))");
  const result = await q.query<{ title: string }>(
    "SELECT title FROM notes WHERE deleted_at IS NULL AND (title=$1 OR title ~ ('^' || $1 || ' [0-9]+$'))", [base],
  );
  const used = new Set(result.rows.map((row) => row.title));
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = untitledCandidate(locale, suffix);
    if (!used.has(candidate)) return candidate;
  }
}

async function createInTransaction(input: CreateNoteInput, client: PoolClient, locale: Locale): Promise<Note> {
  const title = input.title?.trim() || (await uniqueUntitled(client, locale));
  const body = input.body ?? "";
  const tags = mergeTags(input.tags ?? [], parseInlineTags(body));
  const result = await client.query<NoteRow>(
    `INSERT INTO notes (title,body,tags,source_url,search_embedding,search_embedded_at,search_source_hash)
     VALUES ($1,$2,$3,$4,$5::vector,now(),$6) RETURNING *`,
    [title, body, tags, input.sourceUrl ?? null, vectorLiteral(embedText(`${title}\n${body}`)), sourceHash(title, body)],
  );
  const row = result.rows[0]!;
  await materializeLinks(client, row.id, body);
  await resolveTargets(client, row.id, [title]);
  return mapNote(row);
}

export async function createNote(input: CreateNoteInput, client?: PoolClient, locale: Locale = "ko"): Promise<Note> {
  if (!client && databaseBackend() === "sqlite") {
    const { createSQLiteNote } = await import("./sqlite");
    return (await sqliteStore()).transaction((q) => createSQLiteNote(q, input, locale));
  }
  return client ? createInTransaction(input, client, locale) : tx((transaction) => createInTransaction(input, transaction, locale));
}

export async function getNote(id: string): Promise<NoteDetail | null> {
  assertNoteId(id);
  if (databaseBackend() === "sqlite") {
    const { getSQLiteNote } = await import("./sqlite");
    return getSQLiteNote(await sqliteStore(), id);
  }
  const q = await executor();
  const result = await q.query<NoteRow>("SELECT * FROM notes WHERE id=$1", [id]);
  return result.rows[0] ? mapNote(result.rows[0]) : null;
}

export async function updateNote(id: string, input: UpdateNoteInput, options: UpdateNoteOptions = {}): Promise<NoteDetail> {
  assertNoteId(id);
  if (!options.client && databaseBackend() === "sqlite") {
    const { updateSQLiteNote } = await import("./sqlite");
    return (await sqliteStore()).transaction((q) => updateSQLiteNote(q, id, input, options.reason));
  }
  const { client: caller, reason = "edit" } = options;
  const run = async (client: PoolClient): Promise<NoteDetail> => {
    const currentResult = await client.query<NoteRow>("SELECT * FROM notes WHERE id=$1 FOR UPDATE", [id]);
    const current = currentResult.rows[0];
    if (!current) throw new ApiError("not_found", notesCopy.notFound);
    if (current.deleted_at) throw new ApiError("conflict", notesCopy.trashedReadOnly);
    const title = input.title === undefined ? current.title : input.title.trim();
    if (!title) throw new ApiError("validation", notesCopy.titleRequired);
    const body = input.body ?? current.body;
    const tags = mergeTags(input.tags ?? current.tags, parseInlineTags(body));
    let aliases = input.aliases ? normalizeAliases(input.aliases) : current.aliases;
    if (normalizeTitle(title) !== normalizeTitle(current.title)) aliases = normalizeAliases([...aliases, current.title]);
    aliases = aliases.filter((alias) => normalizeTitle(alias) !== normalizeTitle(title));
    const status = input.archived === undefined ? current.status : input.archived ? "archived" : "draft";
    await recordRevision(client, { noteId: id, previous: current, next: { title, body, tags, aliases } }, reason);
    const updated = await client.query<NoteRow>(
      `UPDATE notes SET title=$2,body=$3,tags=$4,aliases=$5,pinned=$6,status=$7,
         search_embedding=$8::vector,search_embedded_at=now(),search_source_hash=$9,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, title, body, tags, aliases, input.pinned ?? current.pinned, status,
        vectorLiteral(embedText(`${title}\n${body}`)), sourceHash(title, body)],
    );
    await materializeLinks(client, id, body);
    await resolveTargets(client, id, [title, ...aliases]);
    return mapNote(updated.rows[0]!);
  };
  return caller ? run(caller) : tx(run);
}

export async function trashNote(id: string): Promise<NoteDetail> {
  assertNoteId(id);
  if (databaseBackend() === "sqlite") {
    const { trashSQLiteNote } = await import("./sqlite");
    return (await sqliteStore()).transaction((q) => trashSQLiteNote(q, id));
  }
  return tx(async (client) => {
    const sources = await client.query<{ id: string; body: string }>(
      "SELECT n.id,n.body FROM links l JOIN notes n ON n.id=l.from_note_id WHERE l.to_note_id=$1 AND n.deleted_at IS NULL", [id],
    );
    const result = await client.query<NoteRow>(
      `UPDATE notes SET deleted_at=coalesce(deleted_at,now()),
         purge_at=coalesce(purge_at,now() + interval '30 days'),updated_at=now() WHERE id=$1 RETURNING *`, [id],
    );
    if (!result.rows[0]) throw new ApiError("not_found", notesCopy.notFound);
    for (const source of sources.rows) await materializeLinks(client, source.id, source.body);
    return mapNote(result.rows[0]);
  });
}

export async function restoreNote(id: string): Promise<NoteDetail> {
  assertNoteId(id);
  if (databaseBackend() === "sqlite") {
    const { restoreSQLiteNote } = await import("./sqlite");
    return (await sqliteStore()).transaction((q) => restoreSQLiteNote(q, id));
  }
  return tx(async (client) => {
    const trashed = await client.query<NoteRow>(
      "SELECT * FROM notes WHERE id=$1 AND deleted_at IS NOT NULL FOR UPDATE", [id],
    );
    const original = trashed.rows[0];
    if (!original) throw new ApiError("not_found", notesCopy.notInTrash);
    const dailyDate = dateOnly(original.daily_date);
    if (dailyDate) {
      // Use the same lock as daily creation so the uniqueness check cannot race it.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`daily:${dailyDate}`]);
      const replacement = await client.query(
        "SELECT id FROM notes WHERE daily_date=$1 AND deleted_at IS NULL", [dailyDate],
      );
      if (replacement.rowCount) {
        throw new ApiError("conflict", notesCopy.dailyConflict);
      }
    }
    const result = await client.query<NoteRow>(
      "UPDATE notes SET deleted_at=NULL,purge_at=NULL,updated_at=now() WHERE id=$1 AND deleted_at IS NOT NULL RETURNING *", [id],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError("not_found", notesCopy.notInTrash);
    await materializeLinks(client, id, row.body);
    await resolveTargets(client, id, [row.title, ...row.aliases]);
    return mapNote(row);
  });
}

/**
 * Permanently delete one trashed note (only once its retention expired for "expired").
 * Attachment keys go to the durable cleanup queue; the caller runs retryAttachmentCleanup after commit.
 */
export async function purgeInTransaction(client: PoolClient, id: string, scope: PurgeScope): Promise<boolean> {
  // Block new attachment foreign-key inserts before collecting deleted rows.
  const note = await client.query(
    `SELECT id FROM notes WHERE id=$1 AND deleted_at IS NOT NULL
       AND ($2::text='trashed' OR purge_at <= now()) FOR UPDATE`, [id, scope],
  );
  if (note.rowCount === 0) return false;
  const sources = await client.query<{ id: string; body: string }>(
    "SELECT n.id,n.body FROM links l JOIN notes n ON n.id=l.from_note_id WHERE l.to_note_id=$1 AND n.deleted_at IS NULL", [id],
  );
  // An attachment another note still links to moves to that note instead of being deleted: an
  // active note first (a trashed one can still be restored), then the most recently edited.
  await client.query(
    `UPDATE attachments a SET note_id=ref.note_id
       FROM (SELECT DISTINCT ON (owned.id) owned.id AS attachment_id, n.id AS note_id
               FROM attachments owned
               JOIN notes n ON n.id<>$1 AND strpos(lower(n.body), '/api/attachments/' || owned.id::text) > 0
              WHERE owned.note_id=$1
              ORDER BY owned.id, (n.deleted_at IS NOT NULL), n.updated_at DESC, n.id) ref
      WHERE a.id=ref.attachment_id`,
    [id],
  );
  const attachments = await client.query<{ storage_key: string }>(
    "DELETE FROM attachments WHERE note_id=$1 RETURNING storage_key", [id],
  );
  const keys = attachments.rows.map((row) => {
    storagePath(row.storage_key);
    return row.storage_key;
  });
  await client.query(
    "INSERT INTO attachment_cleanup (storage_key) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING",
    [keys],
  );
  await client.query("DELETE FROM notes WHERE id=$1", [id]);
  for (const source of sources.rows) await materializeLinks(client, source.id, source.body);
  return true;
}

export async function purgeNote(id: string): Promise<void> {
  assertNoteId(id);
  if (databaseBackend() === "sqlite") {
    const { purgeSQLiteNote } = await import("./sqlite");
    (await sqliteStore()).transaction((q) => {
      if (!purgeSQLiteNote(q, id, "trashed")) throw new ApiError("conflict", notesCopy.purgeOnlyTrashed);
    });
    await retryAttachmentCleanup();
    return;
  }
  await tx(async (client) => {
    if (!(await purgeInTransaction(client, id, "trashed"))) throw new ApiError("conflict", notesCopy.purgeOnlyTrashed);
  });
  // Cleanup failures retain their keys but never turn a committed purge into 500.
  await retryAttachmentCleanup();
}

type Cursor = { updatedAt: string; id: string };
function parseCursor(cursor: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof value.updatedAt !== "string" || typeof value.id !== "string" || !UUID_RE.test(value.id)) throw new Error();
    if (!Number.isFinite(Date.parse(value.updatedAt))) throw new Error();
    return { updatedAt: value.updatedAt, id: value.id };
  } catch { throw new ApiError("validation", notesCopy.badCursor); }
}

export async function listNotes(input: ListNotesInput): Promise<{ notes: NoteListItem[]; nextCursor: string | null }> {
  if (databaseBackend() === "sqlite") {
    const { listSQLiteNotes } = await import("./sqlite");
    return listSQLiteNotes(await sqliteStore(), input);
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const values: unknown[] = [];
  const where = [input.trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
  if (input.archived) where.push("status='archived'");
  else if (!input.trash) where.push("status<>'archived'");
  if (input.pinned) where.push("pinned=true");
  if (input.q) { values.push(`%${input.q}%`); where.push(`(title ILIKE $${values.length} OR body ILIKE $${values.length})`); }
  if (input.tag) { values.push(input.tag.toLowerCase()); where.push(`$${values.length}=ANY(tags)`); }
  if (input.cursor) {
    const cursor = parseCursor(input.cursor);
    values.push(cursor.updatedAt, cursor.id);
    where.push(`(updated_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
  }
  values.push(limit + 1);
  const q = await executor();
  const result = await q.query<NoteRow & { cursor_updated_at: string }>(
    `SELECT *,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
       FROM notes WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,id DESC LIMIT $${values.length}`, values,
  );
  const page = result.rows.slice(0, limit);
  const tail = page[page.length - 1];
  const nextCursor = result.rows.length > limit && tail
    ? Buffer.from(JSON.stringify({ updatedAt: tail.cursor_updated_at, id: tail.id })).toString("base64url") : null;
  return { notes: page.map(mapSummary), nextCursor };
}

export async function findNoteTitles(qText = "", limit = 10): Promise<NoteTitleMatch[]> {
  if (databaseBackend() === "sqlite") {
    const { findSQLiteNoteTitles } = await import("./sqlite");
    return findSQLiteNoteTitles(await sqliteStore(), qText, limit);
  }
  const q = await executor();
  const result = await q.query<NoteRef & { matched_alias: string | null }>(
    `SELECT id,title,CASE WHEN title ILIKE $1 THEN NULL ELSE (
         SELECT alias FROM unnest(aliases) alias WHERE alias ILIKE $1
          ORDER BY lower(alias)=lower($2) DESC,similarity(alias,$2) DESC LIMIT 1) END AS matched_alias
       FROM notes WHERE deleted_at IS NULL AND status<>'archived'
       AND (title ILIKE $1 OR EXISTS (SELECT 1 FROM unnest(aliases) alias WHERE alias ILIKE $1))
     ORDER BY CASE WHEN lower(title)=lower($2)
       OR EXISTS (SELECT 1 FROM unnest(aliases) alias WHERE lower(alias)=lower($2)) THEN 0 ELSE 1 END,
       similarity(title,$2) DESC,updated_at DESC LIMIT $3`,
    [`%${qText}%`, qText, Math.min(Math.max(limit, 1), 50)],
  );
  return result.rows.map((row) => ({ id: row.id, title: row.title, matchedAlias: row.matched_alias }));
}

export async function getOrCreateByTitle(titleInput: string): Promise<Note> {
  if (databaseBackend() === "sqlite") {
    const { getOrCreateSQLiteByTitle } = await import("./sqlite");
    return (await sqliteStore()).transaction((q) => getOrCreateSQLiteByTitle(q, titleInput));
  }
  const title = titleInput.trim();
  if (!title) throw new ApiError("validation", notesCopy.titleRequired);
  return tx(async (client) => {
    const key = normalizeTitle(title);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`notes:title:${key}`]);
    const result = await client.query<NoteRow>(
      `SELECT * FROM notes WHERE deleted_at IS NULL AND
       (lower(trim(regexp_replace(title, '[[:space:]]+', ' ', 'g')))=$1
        OR EXISTS (SELECT 1 FROM unnest(aliases) alias
          WHERE lower(trim(regexp_replace(alias, '[[:space:]]+', ' ', 'g')))=$1))
       ORDER BY created_at LIMIT 1`, [key],
    );
    return result.rows[0] ? mapNote(result.rows[0]) : createNote({ title }, client);
  });
}

export async function getOrCreateDaily(date: string): Promise<Note> {
  if (databaseBackend() === "sqlite") {
    const { getOrCreateSQLiteDaily } = await import("./sqlite");
    return (await sqliteStore()).transaction((q) => getOrCreateSQLiteDaily(q, date));
  }
  return tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`daily:${date}`]);
    const existing = await client.query<NoteRow>("SELECT * FROM notes WHERE daily_date=$1 AND deleted_at IS NULL", [date]);
    if (existing.rows[0]) return mapNote(existing.rows[0]);
    const template = await defaultDailyTemplateBody(client);
    const body = template === null ? "" : renderTemplate(template, { date, title: date });
    const result = await client.query<NoteRow>(
      `INSERT INTO notes (title,body,tags,daily_date,search_embedding,search_embedded_at,search_source_hash)
       VALUES ($1::text,$2,$3,$1::date,$4::vector,now(),$5) RETURNING *`,
      [date, body, mergeTags(parseInlineTags(body)), vectorLiteral(embedText(`${date}\n${body}`)), sourceHash(date, body)],
    );
    const row = result.rows[0]!;
    await materializeLinks(client, row.id, body);
    await resolveTargets(client, row.id, [row.title]);
    return mapNote(row);
  });
}

function contextFor(body: string, names: readonly string[]): string {
  const normalized = new Set(names.map(normalizeTitle));
  const link = parseWikiLinks(body).find((item) => normalized.has(normalizeTitle(item.target)));
  const plainIndex = names.reduce((found, name) => {
    const index = body.toLowerCase().indexOf(name.toLowerCase());
    return index >= 0 && (found < 0 || index < found) ? index : found;
  }, -1);
  const position = link?.start ?? Math.max(0, plainIndex);
  return markdownToText(body.slice(Math.max(0, position - 100), position + 180)).slice(0, 240);
}

export async function getNoteLinks(id: string): Promise<NoteLinks> {
  assertNoteId(id);
  if (databaseBackend() === "sqlite") {
    const { getSQLiteNoteLinks } = await import("./sqlite");
    return getSQLiteNoteLinks(await sqliteStore(), id);
  }
  const q = await executor();
  const noteResult = await q.query<NoteRow>("SELECT * FROM notes WHERE id=$1", [id]);
  const note = noteResult.rows[0];
  if (!note) throw new ApiError("not_found", notesCopy.notFound);
  const outgoing = await q.query<NoteRef>(
    "SELECT n.id,n.title FROM links l JOIN notes n ON n.id=l.to_note_id WHERE l.from_note_id=$1 AND n.deleted_at IS NULL ORDER BY n.title", [id],
  );
  const backlinks = await q.query<{ id: string; title: string; body: string }>(
    "SELECT n.id,n.title,n.body FROM links l JOIN notes n ON n.id=l.from_note_id WHERE l.to_note_id=$1 AND n.deleted_at IS NULL ORDER BY n.updated_at DESC", [id],
  );
  const unresolved = await q.query<{ target_title: string }>(
    "SELECT target_title FROM unresolved_links WHERE from_note_id=$1 ORDER BY target_title", [id],
  );
  const names = [note.title, ...note.aliases];
  const mentions = await q.query<{ id: string; title: string; body: string }>(
    `SELECT id,title,body FROM notes WHERE id<>$1 AND deleted_at IS NULL AND body ILIKE ANY($2::text[])
       AND id NOT IN (SELECT from_note_id FROM links WHERE to_note_id=$1) ORDER BY updated_at DESC LIMIT 50`,
    [id, names.map((name) => `%${name}%`)],
  );
  const withContext = (row: { id: string; title: string; body: string }): LinkContext =>
    ({ id: row.id, title: row.title, context: contextFor(row.body, names) });
  return {
    outgoing: outgoing.rows, backlinks: backlinks.rows.map(withContext),
    unresolved: unresolved.rows.map((row) => row.target_title), unlinkedMentions: mentions.rows.map(withContext),
  };
}

export async function listTags(): Promise<TagCount[]> {
  if (databaseBackend() === "sqlite") {
    const { listSQLiteTags } = await import("./sqlite");
    return listSQLiteTags(await sqliteStore());
  }
  const q = await executor();
  const result = await q.query<TagCount>(
    "SELECT tag,count(*)::int AS count FROM notes,unnest(tags) tag WHERE deleted_at IS NULL GROUP BY tag ORDER BY count DESC,tag",
  );
  return result.rows;
}
