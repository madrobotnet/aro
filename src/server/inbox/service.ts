import type { PoolClient, QueryResultRow } from "pg";
import type { InboxItem, InboxSource, InboxSuggestions, Note } from "@/lib/types";
import type { Locale } from "@/lib/i18n/locale";
import { replacePendingInboxUrlStatus, stripInboxUrlStatus, URL_FAILED_MARKER, URL_PENDING_MARKER } from "@/lib/inbox-url-status";
import { db, tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { sqliteUuid } from "@/server/db/sqlite";
import { ApiError } from "@/server/http";
import { CAPTURE_TITLE, inboxCopy, notesCopy } from "@/server/i18n/copy";
import { createNote, getNote } from "@/server/notes/service";
import { fetchUrlText, type UrlIntakeDependencies } from "./url";
import { discardSQLiteInbox, listSQLiteInbox, promoteSQLiteInbox, sqliteInboxRow } from "./sqlite";
import { buildSuggestions, probability } from "./suggestions";
import { persistCaptureReplay, type CaptureReplay } from "./capture-replay";
import { inboxPreview } from "./preview";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type InboxRow = QueryResultRow & {
  id: string; title: string; body: string; source: string; url: string | null;
  promoted_note_id: string | null; discarded_at: string | Date | null;
  suggestions: unknown; created_at: string | Date; snoozed_until: string | Date | null;
};
export type InboxItemDto = InboxItem;
export type InboxView = "open" | "later";
/** `nextReturnAt` is when the soonest snoozed item comes back, so clients can refresh then. */
export type InboxList = { items: InboxItemDto[]; count: number; snoozedCount: number; nextReturnAt: string | null };

export type CaptureInboxInput = { text?: string; url?: string; title?: string; source?: InboxSource };
export type PromoteInboxInput = { title?: string; body?: string; tags?: string[] };

export function assertInboxId(id: string): void {
  if (!UUID_RE.test(id)) throw new ApiError("validation", notesCopy.badUuid);
}

function readSuggestions(value: unknown): InboxSuggestions | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const status = raw.status === "ready" || raw.status === "unavailable" || raw.status === "failed" ? raw.status : "ready";
  const tags = Array.isArray(raw.tags) ? raw.tags.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const score = probability(item.probability ?? item.noul);
    return typeof item.tag === "string" && item.tag.trim() && score !== null ? [{ tag: item.tag.trim(), probability: score }] : [];
  }) : [];
  const oldKind = raw.classification && typeof raw.classification === "object" ? raw.classification as Record<string, unknown> : null;
  const kindRaw = raw.kind && typeof raw.kind === "object" ? raw.kind as Record<string, unknown> : oldKind;
  const kindScore = kindRaw ? probability(kindRaw.confidence ?? kindRaw.probability) : null;
  const kind = kindRaw && typeof kindRaw.choice === "string" && kindScore !== null
    ? { choice: kindRaw.choice, confidence: kindScore } : null;
  const duplicateRaw = raw.duplicateOf && typeof raw.duplicateOf === "object" ? raw.duplicateOf as Record<string, unknown> : null;
  const duplicateScore = duplicateRaw ? probability(duplicateRaw.probability) : null;
  const duplicateOf = duplicateRaw && typeof duplicateRaw.noteId === "string" && typeof duplicateRaw.title === "string" && duplicateScore !== null
    ? { noteId: duplicateRaw.noteId, title: duplicateRaw.title, probability: duplicateScore } : null;
  return { status, tags, kind, duplicateOf };
}

export function mapItem(row: InboxRow): InboxItemDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    preview: inboxPreview(row),
    homePreview: inboxPreview(row, 280),
    source: (["web", "url", "share", "api"].includes(row.source) ? row.source : "api") as InboxSource,
    url: row.url,
    createdAt: new Date(row.created_at).toISOString(),
    suggestions: readSuggestions(row.suggestions),
    snoozedUntil: row.snoozed_until ? new Date(row.snoozed_until).toISOString() : null,
  };
}

function initialTitle(input: CaptureInboxInput, locale: Locale): string {
  const given = input.title?.trim();
  if (given) return given;
  const firstLine = input.text?.trim().split(/\r?\n/)[0]?.trim();
  if (firstLine) return firstLine.slice(0, 120);
  if (input.url) {
    try { return new URL(input.url).hostname || CAPTURE_TITLE.link[locale]; } catch { return CAPTURE_TITLE.link[locale]; }
  }
  return CAPTURE_TITLE.quick[locale];
}

export async function captureInbox(input: CaptureInboxInput, locale: Locale = "ko", replay?: CaptureReplay): Promise<InboxItemDto> {
  const text = input.text?.trim() ?? "";
  const url = input.url?.trim() || null;
  if (!text && !url) throw new ApiError("validation", inboxCopy.textOrUrl);
  const body = url ? [text, URL_PENDING_MARKER].filter(Boolean).join("\n\n") : text;
  if (replay) {
    // Offline intake does not schedule URL enrichment, so do not promise pending work.
    return persistCaptureReplay(input, replay, initialTitle(input, locale), text, url);
  }
  if (databaseBackend() === "sqlite") {
    const source = input.source ?? (url ? "url" : "web");
    if (!["web", "url", "share", "api"].includes(source)) throw new ApiError("validation", "Invalid inbox source");
    const store = await sqliteStore();
    const row = store.get<InboxRow>(
      "INSERT INTO inbox_items(title,body,source,url) VALUES (?,?,?,?) RETURNING *",
      [initialTitle(input, locale), body, source, url],
    );
    if (!row) throw new ApiError("internal", "Inbox insert did not return a row");
    return mapItem(row);
  }
  const pool = await db();
  const result = await pool.query<InboxRow>(
    "INSERT INTO inbox_items (title,body,source,url) VALUES ($1,$2,$3,$4) RETURNING *",
    [initialTitle(input, locale), body, input.source ?? (url ? "url" : "web"), url],
  );
  return mapItem(result.rows[0]!);
}

const OPEN = "discarded_at IS NULL AND promoted_note_id IS NULL";
const VIEW_SQL: Record<InboxView, string> = {
  open: `SELECT * FROM inbox_items WHERE ${OPEN} AND (snoozed_until IS NULL OR snoozed_until <= now())
          ORDER BY created_at DESC,id DESC`,
  later: `SELECT * FROM inbox_items WHERE ${OPEN} AND snoozed_until > now() ORDER BY snoozed_until,id`,
};

export async function listInbox(view: InboxView = "open"): Promise<InboxList> {
  if (databaseBackend() === "sqlite") return listSQLiteInbox(await sqliteStore(), view);
  const pool = await db();
  const [result, snoozed] = await Promise.all([
    pool.query<InboxRow>(VIEW_SQL[view]),
    pool.query<{ count: number; next: string | Date | null }>(
      `SELECT count(*)::int AS count, min(snoozed_until) AS next FROM inbox_items WHERE ${OPEN} AND snoozed_until > now()`,
    ),
  ]);
  const next = snoozed.rows[0]?.next ?? null;
  return {
    items: result.rows.map(mapItem),
    count: result.rows.length,
    snoozedCount: snoozed.rows[0]?.count ?? 0,
    nextReturnAt: next ? new Date(next).toISOString() : null,
  };
}

async function rowById(id: string, client?: PoolClient): Promise<InboxRow | null> {
  assertInboxId(id);
  if (!client && databaseBackend() === "sqlite") return sqliteInboxRow(await sqliteStore(), id);
  const executor = client ?? await db();
  const result = await executor.query<InboxRow>("SELECT * FROM inbox_items WHERE id=$1", [id]);
  return result.rows[0] ?? null;
}

export async function getInboxItem(id: string): Promise<InboxItemDto | null> {
  const row = await rowById(id);
  return row ? mapItem(row) : null;
}

export async function promoteInbox(id: string, input: PromoteInboxInput = {}, locale: Locale = "ko"): Promise<Note> {
  assertInboxId(id);
  if (databaseBackend() === "sqlite") return promoteSQLiteInbox(await sqliteStore(), id, input, locale);
  const noteId = await tx(async (client) => {
    const locked = await client.query<InboxRow>("SELECT * FROM inbox_items WHERE id=$1 FOR UPDATE", [id]);
    const item = locked.rows[0];
    if (!item) throw new ApiError("not_found", inboxCopy.notFound);
    if (item.discarded_at) throw new ApiError("conflict", inboxCopy.discarded);
    if (item.promoted_note_id) return item.promoted_note_id;
    const note = await createNote({
      title: input.title?.trim() || item.title,
      body: input.body ?? stripInboxUrlStatus(item.body),
      tags: input.tags,
      sourceUrl: item.url,
    }, client, locale);
    await client.query("UPDATE inbox_items SET promoted_note_id=$2 WHERE id=$1", [id, note.id]);
    await client.query("UPDATE attachments SET note_id=$2,inbox_item_id=NULL WHERE inbox_item_id=$1", [id, note.id]);
    return note.id;
  });
  const note = await getNote(noteId);
  if (!note) throw new ApiError("not_found", inboxCopy.promotedMissing);
  return note;
}

export async function discardInbox(id: string): Promise<void> {
  assertInboxId(id);
  if (databaseBackend() === "sqlite") {
    (await sqliteStore()).transaction((q) => discardSQLiteInbox(q, id));
    return;
  }
  await tx(async (client) => {
    const result = await client.query<InboxRow>("SELECT * FROM inbox_items WHERE id=$1 FOR UPDATE", [id]);
    const item = result.rows[0];
    if (!item) throw new ApiError("not_found", inboxCopy.notFound);
    if (item.promoted_note_id) throw new ApiError("conflict", inboxCopy.alreadyPromoted);
    await client.query("UPDATE inbox_items SET discarded_at=coalesce(discarded_at,now()) WHERE id=$1", [id]);
  });
}

export async function suggestInbox(id: string, locale: Locale = "ko"): Promise<InboxItemDto> {
  const item = await rowById(id);
  if (!item) throw new ApiError("not_found", inboxCopy.notFound);
  if (databaseBackend() === "sqlite" && (item.discarded_at || item.promoted_note_id)) return mapItem(item);
  const suggestions = await buildSuggestions(item, locale);
  if (databaseBackend() === "sqlite") {
    const store = await sqliteStore();
    return store.transaction((q) => {
      // Provider work can race promotion, discard or enrichment. Never persist a stale proposal.
      q.run(`UPDATE inbox_items SET suggestions=? WHERE id=? AND promoted_note_id IS NULL
        AND discarded_at IS NULL AND title=? AND body=? AND url IS ?`,
      [JSON.stringify(suggestions), sqliteUuid(id), item.title, item.body, item.url]);
      const current = sqliteInboxRow(q, id);
      if (!current) throw new ApiError("not_found", inboxCopy.notFound);
      return mapItem(current);
    });
  }
  const pool = await db();
  const result = await pool.query<InboxRow>("UPDATE inbox_items SET suggestions=$2::jsonb WHERE id=$1 RETURNING *", [id, JSON.stringify(suggestions)]);
  return mapItem(result.rows[0]!);
}

/** Best-effort post-response URL intake and Jev suggestion persistence. */
export async function enrichInboxItem(id: string, dependencies: UrlIntakeDependencies = {}, locale: Locale = "ko"): Promise<void> {
  const item = await rowById(id);
  if (!item || item.discarded_at || item.promoted_note_id) return;
  if (item.url) {
    const fetched = await fetchUrlText(item.url, dependencies);
    const replacement = fetched.ok && fetched.text ? fetched.text : URL_FAILED_MARKER;
    const body = replacePendingInboxUrlStatus(item.body, replacement);
    if (databaseBackend() === "sqlite") {
      (await sqliteStore()).run(`UPDATE inbox_items SET body=?,url=coalesce(?,url)
        WHERE id=? AND promoted_note_id IS NULL AND discarded_at IS NULL AND body=? AND url IS ?`,
      [body, fetched.ok ? fetched.url : null, sqliteUuid(id), item.body, item.url]);
    } else {
      const pool = await db();
      await pool.query(
        "UPDATE inbox_items SET body=$2,url=CASE WHEN $3::text IS NULL THEN url ELSE $3 END WHERE id=$1 AND promoted_note_id IS NULL AND discarded_at IS NULL",
        [id, body, fetched.ok ? fetched.url : null],
      );
    }
  }
  await suggestInbox(id, locale).catch(() => undefined);
}
