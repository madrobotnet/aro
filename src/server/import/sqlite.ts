import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { rewriteImportBody, type ParsedImport } from "@/lib/import-format";
import type { ImportPreview, ImportReceipt } from "@/lib/import-types";
import { sqliteStore } from "@/server/db/backend";
import { readSQLiteStringArray, type SQLiteExecutor } from "@/server/db/sqlite";
import { ApiError } from "@/server/http";
import { attachmentsDir, storagePath } from "@/server/notes/attachment-storage";
import { createSQLiteNote, updateSQLiteNote } from "@/server/notes/sqlite";
import { attachmentMime, buildImportPreview } from "./service";

export async function commitSQLiteImport(
  filename: string, bytes: Uint8Array, parsed: ParsedImport, digest: string,
): Promise<ImportReceipt> {
  const store = await sqliteStore();
  const checkedPreview = (q: SQLiteExecutor): ImportPreview => {
    const existing = q.all<{ title: string; aliases: string }>("SELECT title,aliases FROM notes")
      .map((row) => ({ ...row, aliases: readSQLiteStringArray(row.aliases) }));
    const checked = buildImportPreview(existing, filename, bytes, parsed);
    if (checked.digest !== digest || !checked.canCommit) {
      throw new ApiError("conflict", "The import preview is stale or contains conflicts. Preview again; no notes were imported.", {
        imported: false, preview: checked,
      });
    }
    return checked;
  };
  checkedPreview(store); // Reject invalid confirmation before staging any bytes.
  const attachments = parsed.attachments.map((attachment) => ({ ...attachment, id: randomUUID() }));
  const urls = new Map(attachments.map((attachment) => [attachment.path, `/api/attachments/${attachment.id}`]));
  const createdFiles: string[] = [];
  let entered = false;
  let callbackFailed = false;
  let callbackError: unknown;
  try {
    // Private UUID paths are staged before the short writer transaction. They become
    // reachable only when attachment metadata commits; no filesystem await holds a lock.
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
    }
    return store.transaction((q) => {
      entered = true;
      try {
        // BEGIN IMMEDIATE owns the writer before checking conflicts again.
        const checked = checkedPreview(q);
        const notes: ImportReceipt["notes"][number][] = [];
        for (const source of parsed.notes) {
          const note = createSQLiteNote(q, { title: source.title, tags: [...source.tags] });
          notes.push({ path: source.path, id: note.id, title: note.title });
        }
        const noteIds = new Map(notes.map((note) => [note.path, note.id]));
        for (const source of parsed.notes) {
          const id = noteIds.get(source.path);
          if (id === undefined) throw new ApiError("internal", "Imported note ID is missing.");
          const body = rewriteImportBody(source, parsed.notes, urls, [], noteIds);
          updateSQLiteNote(q, id, { body, aliases: [...source.aliases] });
        }
        const first = notes[0];
        if (!first) throw new ApiError("validation", "The upload contains no Markdown notes.");
        for (const attachment of attachments) {
          q.run("INSERT INTO attachments(id,note_id,filename,mime,size_bytes,storage_key) VALUES (?,?,?,?,?,?)",
            [attachment.id, first.id, path.posix.basename(attachment.path), attachmentMime(attachment.path),
              attachment.bytes.length, attachment.id]);
        }
        return { status: "imported", notes, attachments: attachments.length, warnings: checked.warnings };
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
        throw error;
      }
    });
  } catch (error) {
    // Bun's native transaction rethrows the callback error only after rollback.
    // A different driver error (including failed rollback), or any error after
    // callback completion/COMMIT, is uncertain. Preserve staged bytes in that case.
    if (entered && (!callbackFailed || error !== callbackError)) {
      throw new ApiError("internal", "Import outcome is unknown. Preview again before retrying; attachment files were preserved.", {
        outcome: "unknown",
      });
    }
    const cleanup = await Promise.allSettled(createdFiles.map((file) => unlink(file)));
    if (cleanup.some((result) => result.status === "rejected")) {
      throw new ApiError("internal", "Import failed and attachment cleanup requires attention.", {
        imported: false, cleanupRequired: true,
      });
    }
    throw error;
  }
}
