import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { z } from "zod";
import { POST as previewPOST } from "@/app/api/import/preview/route";
import * as sessions from "@/server/auth/session";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import type { SQLiteStore } from "@/server/db/sqlite";
import { exportResponse } from "@/server/export/service";
import { storagePath } from "@/server/notes/attachment-storage";
import { createSQLiteNote, updateSQLiteNote } from "@/server/notes/sqlite";
import { commitImport, previewImport } from "./service";

let directory: string;
let store: SQLiteStore;
let writer: Database;
let attachmentSequence = 0;
const keys = ["ARO_DATABASE_MODE", "ARO_SQLITE_PATH", "ATTACHMENTS_DIR"] as const;
const saved = keys.map((key) => process.env[key]);
beforeEach(async () => {
  attachmentSequence = 0;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "aro-portable-sqlite-"));
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = path.join(directory, "notes.sqlite");
  process.env.ATTACHMENTS_DIR = path.join(directory, "attachments");
  await fs.mkdir(process.env.ATTACHMENTS_DIR);
  store = await sqliteStore();
  writer = new Database(process.env.ARO_SQLITE_PATH, { strict: true });
  writer.run("PRAGMA busy_timeout=0");
  writer.run("PRAGMA foreign_keys=ON");
});
afterEach(async () => {
  writer.close(true);
  await closeSQLiteStore();
  await fs.rm(directory, { recursive: true, force: true });
  keys.forEach((key, index) => {
    const value = saved[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

function note(title: string, body = "") {
  return store.transaction((q) => createSQLiteNote(q, { title, body }));
}
async function attachment(noteId: string, filename: string, bytes: Uint8Array = strToU8("payload")) {
  const id = randomUUID();
  await fs.writeFile(storagePath(id), bytes);
  const instant = `2026-10-01T00:00:00.${String(++attachmentSequence).padStart(6, "0")}Z`;
  store.run("INSERT INTO attachments(id,note_id,filename,mime,size_bytes,storage_key,created_at) VALUES (?,?,?,'application/octet-stream',?,?,?)",
    [id, noteId, filename, bytes.length, id, instant]);
  return id;
}
function snapshotReleased() {
  const result = writer.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
  expect(result?.busy).toBe(0);
}
function holdOpen(filePath: string) {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = fs.open;
  let handle: fs.FileHandle | undefined;
  const mock = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (file === filePath) {
      reached.resolve();
      await gate.promise;
    }
    const opened = await original(file, flags, mode);
    if (file === filePath) handle = opened;
    return opened;
  });
  return {
    reached: reached.promise, release: gate.resolve,
    restore: () => mock.mockRestore(), descriptor: () => handle?.fd,
  };
}
const archive = () => zipSync({
  "Start.md": strToU8('---\naliases: ["Beginning"]\ntags: ["work"]\n---\n[[Target]] ![file](assets/picture.png)'),
  "Target.md": strToU8("Target body"),
  "assets/picture.png": new Uint8Array([137, 80, 78, 71]),
});

describe("file-backed WAL portable export", () => {
  test("holds metadata and every body in one snapshot through a concurrent writer and purge", async () => {
    const first = note("Before");
    const kept = await attachment(first.id, "kept.txt");
    const purged = await attachment(first.id, "purged.txt");
    store.run("UPDATE notes SET body=? WHERE id=?", [
      `[kept](/api/attachments/${kept}) [purged](/api/attachments/${purged})`, first.id,
    ]);
    store.transaction((q) => {
      for (let i = 0; i < 205; i++) q.run("INSERT INTO notes(title,body) VALUES (?,?)", [`page ${i}`, "old body"]);
    });
    const hold = holdOpen(storagePath(kept));
    try {
      const response = await exportResponse();
      await hold.reached;
      // This real independent writer fails immediately if export owns a writer lock.
      writer.run("BEGIN IMMEDIATE");
      writer.run("UPDATE notes SET title='After',body='new body' WHERE id=?", [first.id]);
      writer.run("UPDATE notes SET body='edited page' WHERE title LIKE 'page %'");
      writer.run("INSERT INTO notes(title,body) VALUES ('Late','late body')");
      writer.run("DELETE FROM attachments WHERE id=?", [purged]);
      writer.run("COMMIT");
      await fs.unlink(storagePath(purged));
      hold.release();
      const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
      expect(strFromU8(entries["notes/Before.md"] ?? new Uint8Array())).toContain(
        `[kept](../attachments/kept.txt) [purged](/api/attachments/${purged})`,
      );
      expect(entries["notes/After.md"]).toBeUndefined();
      expect(entries["notes/Late.md"]).toBeUndefined();
      const pages = Object.entries(entries).filter(([name]) => name.startsWith("notes/page "));
      expect(pages).toHaveLength(205);
      for (const [, bytes] of pages) expect(strFromU8(bytes)).toContain("old body");
      const manifest = JSON.parse(strFromU8(entries["export-manifest.json"] ?? new Uint8Array()));
      expect(manifest.notes).toHaveLength(206);
      expect(manifest.attachments).toEqual([{ id: kept, path: "attachments/kept.txt" }]);
      expect(manifest.omittedAttachments).toEqual([{ id: purged, reason: "purge_race" }]);
      snapshotReleased();
    } finally {
      hold.release();
      hold.restore();
    }
  });

  test("retains missing metadata and file omissions and skips trash and loose files", async () => {
    const missing = randomUUID();
    const active = note("Active", `[missing](/api/attachments/${missing})`);
    const gone = await attachment(active.id, "gone.txt");
    await fs.unlink(storagePath(gone));
    const trashed = note("Trash");
    store.run("UPDATE notes SET deleted_at=updated_at WHERE id=?", [trashed.id]);
    await attachment(trashed.id, "trash.txt");
    store.run("INSERT INTO attachments(filename,mime,size_bytes,storage_key) VALUES ('loose','text/plain',0,?)", [randomUUID()]);
    const entries = unzipSync(new Uint8Array(await (await exportResponse()).arrayBuffer()));
    const manifest = JSON.parse(strFromU8(entries["export-manifest.json"] ?? new Uint8Array()));
    expect(Object.keys(entries).sort()).toEqual(["export-manifest.json", "notes/Active.md"]);
    expect(manifest.omittedAttachments).toEqual([
      { id: missing, reason: "metadata_missing" }, { id: gone, reason: "file_missing" },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(strFromU8(entries["notes/Active.md"] ?? new Uint8Array())).toContain(`/api/attachments/${missing}`);
  });

  test("cancellation closes the descriptor and snapshot while an attachment open is gated", async () => {
    const owner = note("Cancel");
    const id = await attachment(owner.id, "cancel.txt");
    const hold = holdOpen(storagePath(id));
    try {
      const response = await exportResponse();
      await hold.reached;
      writer.run("UPDATE notes SET body='later'");
      const stream = response.body;
      if (!stream) throw new Error("Missing export stream");
      const cancelled = stream.cancel();
      hold.release();
      await cancelled;
      expect(hold.descriptor()).toBe(-1);
      snapshotReleased();
    } finally {
      hold.release();
      hold.restore();
    }
  });

  test("backpressure bounds attachment reads and cancellation releases a paused writer", async () => {
    const owner = note("Slow download");
    const id = await attachment(owner.id, "large.bin", new Uint8Array(4 * 1024 * 1024));
    const reached = Promise.withResolvers<void>();
    const original = fs.open;
    let handle: fs.FileHandle | undefined;
    let reads = 0;
    const mock = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const opened = await original(file, flags, mode);
      if (file === storagePath(id)) {
        handle = opened;
        const read = opened.read.bind(opened);
        spyOn(opened, "read").mockImplementation(async (...args: Parameters<typeof read>) => {
          const result = await read(...args);
          if (++reads === 16) reached.resolve();
          return result;
        });
      }
      return opened;
    });
    try {
      const response = await exportResponse();
      await reached.promise;
      writer.run("UPDATE notes SET body='changed while paused'");
      const stream = response.body;
      if (!stream) throw new Error("Missing export stream");
      await stream.cancel();
      expect(reads).toBeLessThanOrEqual(17);
      expect(handle?.fd).toBe(-1);
      snapshotReleased();
    } finally {
      mock.mockRestore();
    }
  });

  test("unexpected open failure releases the snapshot and errors the stream", async () => {
    const owner = note("IO error");
    await attachment(owner.id, "file.txt");
    const mock = spyOn(fs, "open").mockRejectedValueOnce(new Error("synthetic disk failure"));
    try {
      const response = await exportResponse();
      writer.run("UPDATE notes SET body='new'");
      await expect(response.arrayBuffer()).rejects.toThrow("synthetic disk failure");
      snapshotReleased();
    } finally {
      mock.mockRestore();
    }
  });

  test("planning filesystem failures close the snapshot before returning an error", async () => {
    const owner = note("Planning error");
    await attachment(owner.id, "file.txt");
    const mock = spyOn(fs, "lstat").mockRejectedValueOnce(new Error("synthetic stat failure"));
    try {
      await expect(exportResponse()).rejects.toThrow("synthetic stat failure");
      writer.run("UPDATE notes SET body='new'");
      snapshotReleased();
    } finally {
      mock.mockRestore();
    }
  });

  test("exports linked bytes even when their owner is trashed", async () => {
    const owner = note("Trash owner");
    const id = await attachment(owner.id, "linked.txt");
    store.run("UPDATE notes SET deleted_at=updated_at WHERE id=?", [owner.id]);
    note("Active link", `[linked](/api/attachments/${id.toUpperCase()})`);
    const entries = unzipSync(new Uint8Array(await (await exportResponse()).arrayBuffer()));
    const manifest = JSON.parse(strFromU8(entries["export-manifest.json"] ?? new Uint8Array()));
    expect(manifest.attachments).toEqual([{ id, path: "attachments/linked.txt" }]);
    expect(manifest.omittedAttachments).toEqual([]);
    expect(entries["notes/Trash owner.md"]).toBeUndefined();
    expect(strFromU8(entries["attachments/linked.txt"] ?? new Uint8Array())).toBe("payload");
    expect(strFromU8(entries["notes/Active link.md"] ?? new Uint8Array())).toContain("../attachments/linked.txt");
  });
});

describe("native additive SQLite import", () => {
  for (const fragment of ["", "#section"]) test(`persists ordinary Markdown note links${fragment ? " with fragments" : ""} as rendered UUID destinations with preview warnings`, async () => {
    // Given
    const bytes = zipSync({
      "Source.md": strToU8(`[Read **target** \`code\`](Target.md${fragment} "title")\n\n[reference][target]\n\n[target]: <Target.md${fragment}>`),
      "Target.md": strToU8("# section\n\nTarget body"),
    });
    // Only the framework session read is substituted; the upload, route, preview
    // planner and file-backed database all use production implementations.
    const session = spyOn(sessions, "getSession").mockResolvedValue({
      id: randomUUID(), userId: randomUUID(), expiresAt: "2099-01-01T00:00:00Z",
    });
    let response: Response;
    try {
      response = await previewPOST(new Request("http://localhost/api/import/preview", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-import-filename": "markdown-links.zip" },
        body: new Blob([Uint8Array.from(bytes)]),
      }), undefined);
    } finally {
      session.mockRestore();
    }
    expect(response.status).toBe(200);
    const preview = z.object({
      canCommit: z.boolean(), digest: z.string(),
      warnings: z.array(z.object({ path: z.string(), code: z.string(), detail: z.string() })),
    }).parse(await response.json());
    expect(preview.canCommit).toBe(true);
    expect(preview.warnings.map(({ code }) => code)).toEqual(
      fragment ? ["markdown_note_graph_unsupported", "unsupported_note_fragment"] : ["markdown_note_graph_unsupported"],
    );
    expect(preview.warnings.every(({ path }) => path === "Source.md")).toBe(true);
    // When
    const receipt = await commitImport("markdown-links.zip", bytes, preview.digest);
    // Then
    expect(receipt.status).toBe("imported");
    expect(receipt.warnings).toEqual(preview.warnings);
    const source = receipt.notes.find((n) => n.title === "Source");
    const target = receipt.notes.find((n) => n.title === "Target");
    if (!source || !target) throw new Error("Missing imported Markdown notes");
    const persisted = store.get<{ body: string }>("SELECT body FROM notes WHERE id=?", [source.id]);
    expect(persisted?.body).toBe(
      `[Read **target** \`code\`](/notes/${target.id}${fragment} "title")\n\n[reference][target]\n\n[target]: </notes/${target.id}${fragment}>`,
    );
    const rendered = renderToStaticMarkup(createElement(ReactMarkdown, null, persisted?.body));
    expect(rendered).toContain(`<a href="/notes/${target.id}${fragment}" title="title">Read <strong>target</strong> <code>code</code></a>`);
    expect(rendered).toContain(`<a href="/notes/${target.id}${fragment}">reference</a>`);
    expect(store.all("SELECT from_note_id,to_note_id FROM links")).toEqual([]);
    // Transfer the already-imported notebook, not just the original vault.
    const exported = new Uint8Array(await (await exportResponse(new Date(), { wikiLinks: "portable" })).arrayBuffer());
    store.run("DELETE FROM notes");
    const secondPreview = await previewImport("second.zip", exported);
    expect(secondPreview.canCommit).toBe(true);
    const second = await commitImport("second.zip", exported, secondPreview.digest);
    const secondSource = second.notes.find((n) => n.title === "Source");
    const secondTarget = second.notes.find((n) => n.title === "Target");
    if (!secondSource || !secondTarget) throw new Error("Missing transferred notes");
    expect(secondTarget.id).not.toBe(target.id);
    const transferred = store.get<{ body: string }>("SELECT body FROM notes WHERE id=?", [secondSource.id]);
    const transferredHtml = renderToStaticMarkup(createElement(ReactMarkdown, null, transferred?.body));
    expect(transferredHtml).toContain(`<a href="/notes/${secondTarget.id}${fragment}" title="title">`);
    expect(transferredHtml).toContain(`<a href="/notes/${secondTarget.id}${fragment}">reference</a>`);
    expect(transferred?.body).not.toContain(`/notes/${target.id}`);
  });

  test("roundtrips current portable zip aliases links bytes and preservation warnings", async () => {
    const target = note("A/B");
    store.transaction((q) => updateSQLiteNote(q, target.id, { aliases: ["Former"], pinned: true, archived: true }));
    const source = note("Source");
    const id = await attachment(source.id, "diagram.png");
    store.transaction((q) => updateSQLiteNote(q, source.id, { body: `[[Former]] ![diagram](/api/attachments/${id})` }));
    const bytes = new Uint8Array(await (await exportResponse(new Date(), { wikiLinks: "portable" })).arrayBuffer());
    store.run("DELETE FROM notes");
    await fs.unlink(storagePath(id));
    const preview = await previewImport("export.zip", bytes);
    expect(preview.canCommit).toBe(true);
    expect(preview.warnings.length).toBeGreaterThan(0); // IDs, timestamps, pin/archive are not restored.
    expect(store.get<{ count: bigint }>("SELECT count(*) AS count FROM notes")?.count).toBe(0n);
    expect(await fs.readdir(process.env.ATTACHMENTS_DIR ?? "")).toEqual([]);
    const receipt = await commitImport("export.zip", bytes, preview.digest);
    expect(receipt.warnings).toEqual(preview.warnings);
    expect(receipt.attachments).toBe(1);
    const importedSource = receipt.notes.find((n) => n.title === "Source");
    const importedTarget = receipt.notes.find((n) => n.title === "A/B");
    if (!importedSource || !importedTarget) throw new Error("Missing roundtrip notes");
    expect(importedTarget.id).not.toBe(target.id);
    expect(store.get<{ aliases: string; pinned: bigint; status: string }>("SELECT aliases,pinned,status FROM notes WHERE id=?", [importedTarget.id]))
      .toMatchObject({ aliases: '["Former"]', pinned: 0n, status: "draft" });
    expect(store.all("SELECT from_note_id,to_note_id FROM links")).toEqual([
      { from_note_id: importedSource.id, to_note_id: importedTarget.id },
    ]);
    const file = store.get<{ id: string; storage_key: string }>("SELECT id,storage_key FROM attachments");
    if (!file) throw new Error("Missing roundtrip attachment");
    expect(new Uint8Array(await fs.readFile(storagePath(file.storage_key)))).toEqual(strToU8("payload"));
    expect(store.get<{ body: string }>("SELECT body FROM notes WHERE id=?", [importedSource.id])?.body)
      .toContain(`/api/attachments/${file.id}`);
  });

  test("rejects changed bytes repeat imports and aliases in trash without writes", async () => {
    const bytes = archive();
    const preview = await previewImport("vault.zip", bytes);
    await expect(commitImport("vault.zip", archive().subarray(0, 20), preview.digest)).rejects.toMatchObject({ code: "validation" });
    await expect(commitImport("vault.zip", zipSync({ "Different.md": strToU8("changed") }), preview.digest))
      .rejects.toMatchObject({ code: "conflict" });
    expect(store.all("SELECT id FROM notes")).toEqual([]);
    await commitImport("vault.zip", bytes, preview.digest);
    const files = await fs.readdir(process.env.ATTACHMENTS_DIR ?? "");
    await expect(commitImport("vault.zip", bytes, preview.digest)).rejects.toMatchObject({ code: "conflict" });
    expect(await fs.readdir(process.env.ATTACHMENTS_DIR ?? "")).toEqual(files);
    store.run("UPDATE notes SET deleted_at=updated_at WHERE title='Start'");
    expect((await previewImport("Beginning.md", strToU8("body"))).canCommit).toBe(false);
    expect((await previewImport("dup.zip", zipSync({ "a/Same.md": strToU8("a"), "b/Same.md": strToU8("b") }))).canCommit).toBe(false);
  });

  test("rechecks conflicts after staging without holding a SQLite writer lock", async () => {
    const bytes = archive();
    const preview = await previewImport("vault.zip", bytes);
    const original = fs.open;
    const mock = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      writer.run("INSERT INTO notes(title,body) VALUES ('Start','concurrent')");
      return original(file, flags, mode);
    });
    try {
      await expect(commitImport("vault.zip", bytes, preview.digest)).rejects.toMatchObject({ code: "conflict" });
      expect(store.all("SELECT title,body FROM notes")).toEqual([{ title: "Start", body: "concurrent" }]);
      expect(await fs.readdir(process.env.ATTACHMENTS_DIR ?? "")).toEqual([]);
    } finally {
      mock.mockRestore();
    }
  });

  test("rolls back notes links and staged files on a real metadata constraint failure", async () => {
    const bytes = archive();
    const preview = await previewImport("vault.zip", bytes);
    writer.run("CREATE TRIGGER reject_import BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'reject attachment'); END");
    await expect(commitImport("vault.zip", bytes, preview.digest)).rejects.toThrow("reject attachment");
    for (const table of ["notes", "links", "unresolved_links", "attachments"]) {
      expect(store.all(`SELECT * FROM ${table}`)).toEqual([]);
    }
    expect(await fs.readdir(process.env.ATTACHMENTS_DIR ?? "")).toEqual([]);
  });

  test("cleans staged files after a later filesystem open fails", async () => {
    const bytes = zipSync({
      "Note.md": strToU8("note"), "one.bin": strToU8("one"), "two.bin": strToU8("two"),
    });
    const preview = await previewImport("files.zip", bytes);
    const original = fs.open;
    let opened = 0;
    const mock = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (++opened === 2) throw new Error("synthetic staging failure");
      return original(file, flags, mode);
    });
    try {
      await expect(commitImport("files.zip", bytes, preview.digest)).rejects.toThrow("synthetic staging failure");
      expect(store.all("SELECT id FROM notes")).toEqual([]);
      expect(await fs.readdir(process.env.ATTACHMENTS_DIR ?? "")).toEqual([]);
    } finally {
      mock.mockRestore();
    }
  });

  test("preserves committed bytes when the native transaction response is lost", async () => {
    const bytes = archive();
    const preview = await previewImport("vault.zip", bytes);
    const transaction = store.transaction.bind(store);
    const mock = spyOn(store, "transaction").mockImplementation((callback) => {
      transaction(callback);
      throw new Error("synthetic lost COMMIT response");
    });
    try {
      await expect(commitImport("vault.zip", bytes, preview.digest)).rejects.toMatchObject({
        code: "internal", extra: { outcome: "unknown" },
      });
      const file = store.get<{ storage_key: string }>("SELECT storage_key FROM attachments");
      if (!file) throw new Error("Missing committed attachment");
      expect(new Uint8Array(await fs.readFile(storagePath(file.storage_key)))).toEqual(new Uint8Array([137, 80, 78, 71]));
    } finally {
      mock.mockRestore();
    }
  });

  test("serializes confirmed imports so exactly one succeeds", async () => {
    const bytes = archive();
    const preview = await previewImport("vault.zip", bytes);
    const results = await Promise.allSettled([
      commitImport("vault.zip", bytes, preview.digest), commitImport("vault.zip", bytes, preview.digest),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(store.all("SELECT id FROM notes")).toHaveLength(2);
    expect(await fs.readdir(process.env.ATTACHMENTS_DIR ?? "")).toHaveLength(1);
  });

  test("preserves staged bytes when the rollback response cannot be established", async () => {
    const bytes = archive();
    const preview = await previewImport("vault.zip", bytes);
    writer.run("CREATE TRIGGER reject_import BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'reject attachment'); END");
    const transaction = store.transaction.bind(store);
    const mock = spyOn(store, "transaction").mockImplementation((callback) => {
      try {
        return transaction(callback);
      } catch (error) {
        throw new Error("synthetic lost rollback response", { cause: error });
      }
    });
    try {
      await expect(commitImport("vault.zip", bytes, preview.digest)).rejects.toMatchObject({
        code: "internal", extra: { outcome: "unknown" },
      });
      expect(store.all("SELECT id FROM notes")).toEqual([]);
      const files = await fs.readdir(process.env.ATTACHMENTS_DIR ?? "");
      expect(files).toHaveLength(1);
      const file = files[0];
      if (!file) throw new Error("Missing staged bytes");
      expect(new Uint8Array(await fs.readFile(path.join(process.env.ATTACHMENTS_DIR ?? "", file))))
        .toEqual(new Uint8Array([137, 80, 78, 71]));
    } finally {
      mock.mockRestore();
    }
  });
});
