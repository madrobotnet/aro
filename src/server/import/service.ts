import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { parseImport, rewriteImportBody, type ParsedImport } from "@/lib/import-format";
import type { ImportPreview, ImportReceipt } from "@/lib/import-types";
import { normalizeTitle } from "@/lib/wikilinks";
import { db, tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { readSQLiteStringArray } from "@/server/db/sqlite";
import { ApiError } from "@/server/http";
import { attachmentsDir, storagePath } from "@/server/notes/attachment-storage";
import { createNote, updateNote } from "@/server/notes/service";

type ExistingNote = { readonly title: string; readonly aliases: string[] };
type Executor = Pick<PoolClient, "query">;

async function preview(
  q: Executor, filename: string, bytes: Uint8Array, parsed: ParsedImport,
): Promise<ImportPreview> {
  // Include trash: a later restore must not unexpectedly collide with an import.
  const existing = (await q.query<ExistingNote>("SELECT title,aliases FROM notes")).rows;
  return buildImportPreview(existing, filename, bytes, parsed);
}

export function buildImportPreview(
  existing: readonly ExistingNote[], filename: string, bytes: Uint8Array, parsed: ParsedImport,
): ImportPreview {
  const used = new Set(existing.flatMap((note) => [note.title, ...note.aliases]).map(normalizeTitle));
  const incoming = new Map<string, string>();
  const conflicts: ImportPreview["conflicts"][number][] = [];
  for (const note of parsed.notes) {
    for (const name of new Set([note.title, ...note.aliases].map(normalizeTitle))) {
      if (used.has(name)) {
        conflicts.push({ path: note.path, title: note.title, reason: `Existing title or alias: ${name}` });
      }
      const other = incoming.get(name);
      if (other !== undefined && other !== note.path) {
        conflicts.push({ path: note.path, title: note.title, reason: `Duplicate title or alias in ${other}: ${name}` });
      }
      incoming.set(name, note.path);
    }
  }
  const warnings = [...parsed.warnings];
  const attachmentUrls = new Map(parsed.attachments.map((attachment) =>
    [attachment.path, "/api/attachments/00000000-0000-4000-8000-000000000000"]));
  for (const note of parsed.notes) rewriteImportBody(note, parsed.notes, attachmentUrls, warnings);
  const plan = {
    notes: parsed.notes.map(({ path: sourcePath, title }) => ({ path: sourcePath, title })),
    attachments: parsed.attachments.length,
    warnings,
    conflicts,
    canCommit: parsed.notes.length > 0 && conflicts.length === 0,
  };
  // Bind confirmation to the exact upload and reviewed warnings/conflicts. Commit re-parses
  // every byte and queries current state; this digest is not an authorization credential.
  const digest = createHash("sha256").update(filename).update("\0").update(bytes)
    .update(JSON.stringify(plan)).digest("hex");
  return { digest, ...plan };
}

export async function previewImport(filename: string, bytes: Uint8Array): Promise<ImportPreview> {
  const parsed = parseImport(filename, bytes);
  if (databaseBackend() === "sqlite") {
    const existing = (await sqliteStore()).all<{ title: string; aliases: string }>("SELECT title,aliases FROM notes")
      .map((row) => ({ ...row, aliases: readSQLiteStringArray(row.aliases) }));
    return buildImportPreview(existing, filename, bytes, parsed);
  }
  return preview(await db(), filename, bytes, parsed);
}

export async function commitImport(filename: string, bytes: Uint8Array, digest: string): Promise<ImportReceipt> {
  const parsed = parseImport(filename, bytes);
  if (databaseBackend() === "sqlite") {
    return (await import("./sqlite")).commitSQLiteImport(filename, bytes, parsed, digest);
  }
  const createdFiles: string[] = [];
  let commitPending = false;
  try {
    return await tx(async (client) => {
      // Ordinary note writes need ROW EXCLUSIVE, so this closes the check/insert race
      // even with writers that do not participate in the import advisory protocol.
      await client.query("LOCK TABLE notes IN SHARE ROW EXCLUSIVE MODE");
      const checked = await preview(client, filename, bytes, parsed);
      if (checked.digest !== digest || !checked.canCommit) {
        throw new ApiError("conflict", "The import preview is stale or contains conflicts. Preview again; no notes were imported.", {
          imported: false, preview: checked,
        });
      }
      const attachments = parsed.attachments.map((attachment) => ({ ...attachment, id: randomUUID() }));
      const urls = new Map(attachments.map((attachment) => [attachment.path, `/api/attachments/${attachment.id}`]));
      const notes: ImportReceipt["notes"][number][] = [];
      for (const source of parsed.notes) {
        const note = await createNote({ title: source.title, tags: [...source.tags] }, client);
        notes.push({ path: source.path, id: note.id, title: note.title });
      }
      const noteIds = new Map(notes.map((note) => [note.path, note.id]));
      for (const source of parsed.notes) {
        const id = noteIds.get(source.path);
        if (id === undefined) throw new ApiError("internal", "Imported note ID is missing.");
        const body = rewriteImportBody(source, parsed.notes, urls, [], noteIds);
        await updateNote(id, { body, aliases: [...source.aliases] }, { client });
      }
      const first = notes[0];
      if (!first) throw new ApiError("validation", "The upload contains no Markdown notes.");
      if (attachments.length > 0) await mkdir(attachmentsDir(), { recursive: true });
      for (const attachment of attachments) {
        const filePath = storagePath(attachment.id);
        const file = await open(filePath, "wx");
        createdFiles.push(filePath);
        try {
          await file.writeFile(attachment.bytes);
        } finally {
          await file.close();
        }
        // Associate even unreferenced local files with this import's first note, not
        // a pre-existing note. Normal purge logic protects links from other notes.
        await client.query(
          "INSERT INTO attachments (id,note_id,filename,mime,size_bytes,storage_key) VALUES ($1,$2,$3,$4,$5,$6)",
          [attachment.id, first.id, path.posix.basename(attachment.path), attachmentMime(attachment.path), attachment.bytes.length, attachment.id],
        );
      }
      commitPending = true;
      return { status: "imported", notes, attachments: attachments.length, warnings: checked.warnings };
    });
  } catch (error) {
    // The transaction callback completed, so the database may already have
    // committed. A lost COMMIT response must never delete committed file bytes.
    if (commitPending) {
      throw new ApiError("internal", "Import outcome is unknown. Preview again before retrying; attachment files were preserved.", {
        outcome: "unknown",
      });
    }
    const cleanup = await Promise.allSettled(createdFiles.map((file) => unlink(file)));
    const failed = cleanup.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      console.error("[import] rollback file cleanup failed", { count: failed.length });
      throw new ApiError("internal", "Import failed and attachment cleanup requires attention.", {
        imported: false, cleanupRequired: true,
      });
    }
    throw error;
  }
}

export function attachmentMime(filename: string): string {
  switch (path.posix.extname(filename).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".pdf": return "application/pdf";
    case ".mp3": return "audio/mpeg";
    case ".mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}
