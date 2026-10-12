import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import type { PoolClient } from "pg";
import {
  attachmentHref, createNameAllocator, createPortableLinkResolver, noteMarkdown, safeAttachmentName, safeFileName,
  type ExportNote, type ExportNoteFile,
} from "@/lib/export-format";
import { db } from "@/server/db";
import { databaseBackend } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { storagePath } from "@/server/notes/attachment-storage";

const NOTE_BATCH = 100;
const READ_CHUNK_BYTES = 64 * 1024;
/** Zip bytes buffered ahead of a slow download before the writer pauses. */
const BUFFERED_BYTES = 1024 * 1024;

export type NoteRow = {
  id: string; title: string; body: string; tags: string[]; aliases: string[]; pinned: boolean; status: string;
  source_url: string | null; daily_date: string | null; created_at: Date; updated_at: Date; cursor: string;
};
export type AttachmentRow = { id: string; filename: string; storage_key: string; created_at: Date };
type PlannedAttachment = { readonly id: string; readonly path: string; readonly storageKey: string; readonly mtime: Date };
type Omission = { readonly id: string; readonly reason: "metadata_missing" | "file_missing" | "purge_race" };
type ExportPlan = {
  readonly attachments: readonly PlannedAttachment[];
  readonly omissions: Omission[];
  readonly notes: readonly ExportNoteFile[];
};
export type ExportOptions = { readonly wikiLinks?: "preserve" | "portable" };
export type ExportSnapshot = {
  metadata(): Promise<{
    notes: { id: string; title: string; aliases: string[] }[];
    attachments: AttachmentRow[];
    missing: { id: string }[];
  }>;
  notes(): AsyncGenerator<NoteRow>;
  close(): void | Promise<void>;
};
type ArchiveSource = { readonly snapshot: ExportSnapshot; readonly plan: ExportPlan; readonly now: Date; readonly options: ExportOptions };
type Sink = { readonly cancelled: boolean; drained(): Promise<void> };

// Exported notes are every note outside the trash (active and archived); chat and inbox live elsewhere.
const NOTES_SQL = `
  SELECT id,title,body,tags,aliases,pinned,status,source_url,to_char(daily_date,'YYYY-MM-DD') AS daily_date,
    created_at,updated_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor
  FROM notes WHERE deleted_at IS NULL
    AND ($1::timestamptz IS NULL OR (created_at,id) > ($1::timestamptz,$2::uuid))
  ORDER BY created_at,id LIMIT $3`;
// Attachments owned by an exported note or linked from one.
const ATTACHMENTS_SQL = `
  WITH exported AS (SELECT id,body FROM notes WHERE deleted_at IS NULL),
  linked AS (
    SELECT DISTINCT lower(m[1])::uuid AS id FROM exported,
      regexp_matches(exported.body,
        '/api/attachments/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') AS m
  )
  SELECT a.id,a.filename,a.storage_key,a.created_at FROM attachments a
   WHERE a.note_id IN (SELECT id FROM exported) OR a.id IN (SELECT id FROM linked)
   ORDER BY a.created_at,a.id`;
const MISSING_METADATA_SQL = `
  SELECT DISTINCT lower(m[1]) AS id FROM notes,
    regexp_matches(body,
      '/api/attachments/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') AS m
  WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM attachments WHERE id=lower(m[1])::uuid)`;

export function exportFileName(now: Date): string {
  return `aro-export-${now.toISOString().slice(0, 10)}.zip`;
}

function isMissingFile(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === "not_found"; // storagePath rejected the key
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP");
}

/**
 * fflate sets the UTF-8 name flag, but Info-ZIP `unzip` on Linux only decodes non-ASCII names
 * from the Unicode Path extra field (0x7075: version 1, CRC-32 of the header name, UTF-8 name).
 */
function entry<T extends ZipDeflate | ZipPassThrough>(file: T, mtime: Date): T {
  file.mtime = mtime;
  const name = strToU8(file.filename);
  if (name.length !== file.filename.length) {
    const field = new Uint8Array(5 + name.length);
    field[0] = 1;
    new DataView(field.buffer).setUint32(1, crc32(name), true);
    field.set(name, 5);
    file.extra = { 0x7075: field };
  }
  return file;
}

async function planExport(snapshot: ExportSnapshot, options: ExportOptions): Promise<ExportPlan> {
  const { notes: noteRows, attachments: rows, missing } = await snapshot.metadata();
  const allocateNote = createNameAllocator();
  const notes = noteRows.map((row) => ({
    ...row,
    path: `notes/${allocateNote(safeFileName(
      options.wikiLinks === "portable" ? row.title.replace(/[#[\]]/g, "-") : row.title, "untitled",
    ), ".md")}`,
  }));
  const omissions: Omission[] = missing.map(({ id }) => ({ id, reason: "metadata_missing" }));
  const allocate = createNameAllocator();
  const attachments: PlannedAttachment[] = [];
  for (const row of rows) {
    try {
      if (!(await lstat(storagePath(row.storage_key))).isFile()) {
        omissions.push({ id: row.id, reason: "file_missing" });
        continue;
      }
    } catch (error) {
      if (isMissingFile(error)) {
        omissions.push({ id: row.id, reason: "file_missing" });
        continue;
      }
      throw error;
    }
    const { stem, extension } = safeAttachmentName(row.filename);
    const name = allocate(stem, extension);
    attachments.push({ id: row.id, path: `attachments/${name}`, storageKey: row.storage_key, mtime: row.created_at });
  }
  return { attachments, omissions, notes };
}

/** Keyset pages ordered by creation, so the oldest of two same-titled notes keeps the plain name. */
async function* exportedNotes(client: PoolClient): AsyncGenerator<NoteRow> {
  let after: { at: string | null; id: string | null } = { at: null, id: null };
  for (;;) {
    const { rows } = await client.query<NoteRow>(NOTES_SQL, [after.at, after.id, NOTE_BATCH]);
    yield* rows;
    const last = rows.at(-1);
    if (!last || rows.length < NOTE_BATCH) return;
    after = { at: last.cursor, id: last.id };
  }
}

function toExportNote(row: NoteRow): ExportNote {
  return {
    id: row.id, title: row.title, aliases: row.aliases, tags: row.tags, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), dailyDate: row.daily_date, sourceUrl: row.source_url,
    pinned: row.pinned, archived: row.status === "archived", body: row.body,
  };
}

async function writeAttachment(zip: Zip, sink: Sink, attachment: PlannedAttachment): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(storagePath(attachment.storageKey), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  try {
    if (sink.cancelled) return false;
    if (!(await handle.stat()).isFile()) return false;
    const file = entry(new ZipPassThrough(attachment.path), attachment.mtime);
    zip.add(file);
    for (;;) {
      const chunk = new Uint8Array(READ_CHUNK_BYTES); // fresh buffer: the stream keeps each chunk
      const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, null);
      file.push(chunk.subarray(0, bytesRead), bytesRead === 0);
      if (bytesRead === 0) return true;
      if (sink.cancelled) return false;
      await sink.drained();
    }
  } finally {
    await handle.close();
  }
}

/** Compression also obeys the byte budget, including large bodies and the ID mapping receipt. */
async function writeText(zip: Zip, sink: Sink, path: string, mtime: Date, text: string): Promise<void> {
  if (sink.cancelled) return;
  const file = entry(new ZipDeflate(path, { level: 6 }), mtime);
  const bytes = strToU8(text);
  zip.add(file);
  for (let offset = 0; offset < bytes.length; offset += READ_CHUNK_BYTES) {
    if (sink.cancelled) return;
    file.push(bytes.subarray(offset, offset + READ_CHUNK_BYTES), false);
    await sink.drained();
  }
  if (!sink.cancelled) file.push(new Uint8Array(0), true);
  await sink.drained();
}

async function writeArchive(zip: Zip, sink: Sink, source: ArchiveSource): Promise<void> {
  const { snapshot, plan } = source;
  const hrefs = new Map<string, string>();
  // Write bytes before rewriting any links. An open descriptor survives a concurrent unlink;
  // a purge before open gets an omission receipt and retains its original API URL.
  for (const attachment of plan.attachments) {
    if (sink.cancelled) return;
    if (await writeAttachment(zip, sink, attachment)) {
      hrefs.set(attachment.id, attachmentHref(attachment.path.slice("attachments/".length)));
    } else {
      plan.omissions.push({ id: attachment.id, reason: "purge_race" });
    }
  }
  const paths = new Map(plan.notes.map((note) => [note.id, note.path]));
  const resolve = source.options.wikiLinks === "portable" ? createPortableLinkResolver(plan.notes) : undefined;
  for await (const row of snapshot.notes()) {
    if (sink.cancelled) return;
    const path = paths.get(row.id);
    if (path === undefined) throw new ApiError("internal", "Export snapshot note mapping is missing.");
    await writeText(zip, sink, path, row.updated_at, noteMarkdown(toExportNote(row), hrefs, resolve));
  }
  if (sink.cancelled) return;
  await writeText(zip, sink, "export-manifest.json", source.now, JSON.stringify({
    version: 1,
    wikiLinks: source.options.wikiLinks ?? "preserve",
    notes: plan.notes,
    attachments: plan.attachments.filter(({ id }) => hrefs.has(id)).map(({ id, path }) => ({ id, path })),
    omittedAttachments: plan.omissions.sort((a, b) => a.id.localeCompare(b.id)),
  }));
  if (!sink.cancelled) zip.end();
}

/** Zip bytes produced on demand: the writer waits whenever the download falls behind. */
function archiveStream(source: ArchiveSource): ReadableStream<Uint8Array> {
  let cancelled = false;
  let resume: (() => void) | undefined;
  let writer: Promise<void>;
  let zip: Zip;
  const wake = () => {
    resume?.();
    resume = undefined;
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((error, chunk) => {
        if (cancelled) return;
        if (error) throw error;
        controller.enqueue(chunk);
      });
      const sink: Sink = {
        get cancelled() { return cancelled; },
        async drained() {
          while (!cancelled && (controller.desiredSize ?? 0) <= 0) await new Promise<void>((resolve) => { resume = resolve; });
        },
      };
      writer = (async () => {
        try {
          await writeArchive(zip, sink, source);
        } finally {
          await source.snapshot.close();
        }
      })().then(() => {
        if (!cancelled) controller.close();
      }, (error: unknown) => {
        zip.terminate();
        if (!cancelled) controller.error(error);
      });
    },
    pull: wake,
    async cancel() {
      cancelled = true;
      wake();
      zip.terminate();
      await writer;
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: BUFFERED_BYTES }));
}

/** The whole export as a streamed zip download (notes/*.md plus attachments/*). */
export async function exportResponse(now: Date = new Date(), options: ExportOptions = {}): Promise<Response> {
  const snapshot = databaseBackend() === "sqlite"
    ? await (await import("./sqlite")).sqliteExportSnapshot()
    : await postgresExportSnapshot();
  let plan: ExportPlan;
  try {
    plan = await planExport(snapshot, options);
  } catch (error) {
    await snapshot.close();
    throw error;
  }
  return new Response(archiveStream({ snapshot, plan, now, options }), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename=${exportFileName(now)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function postgresExportSnapshot(): Promise<ExportSnapshot> {
  const client = await (await db()).connect();
  const close = async () => {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async metadata() {
      const notes = (await client.query<{ id: string; title: string; aliases: string[] }>(
        "SELECT id,title,aliases FROM notes WHERE deleted_at IS NULL ORDER BY created_at,id",
      )).rows;
      const attachments = (await client.query<AttachmentRow>(ATTACHMENTS_SQL)).rows;
      const missing = (await client.query<{ id: string }>(MISSING_METADATA_SQL)).rows;
      return { notes, attachments, missing };
    },
    notes: () => exportedNotes(client),
    close,
  };
}
