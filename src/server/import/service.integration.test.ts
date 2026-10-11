import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as database from "@/server/db";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { query } from "@/server/db";
import { exportResponse } from "@/server/export/service";
import { saveAttachment } from "@/server/notes/attachments";
import { storagePath } from "@/server/notes/attachment-storage";
import { createNote, getNote, getNoteLinks, trashNote, updateNote } from "@/server/notes/service";
import { closeDb, connectTestDatabase, resetData } from "@/server/test/db";
import { commitImport, previewImport } from "./service";

connectTestDatabase();
const directory = await mkdtemp(path.join(os.tmpdir(), "aro-import-test-"));
const oldDirectory = process.env.ATTACHMENTS_DIR;
beforeEach(async () => {
  process.env.ATTACHMENTS_DIR = directory;
  await resetData();
  for (const file of await readdir(directory)) await rm(path.join(directory, file));
});
afterAll(async () => {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
  if (oldDirectory === undefined) delete process.env.ATTACHMENTS_DIR;
  else process.env.ATTACHMENTS_DIR = oldDirectory;
});

const archive = () => zipSync({
  "Start.md": strToU8('---\naliases: ["Beginning"]\ntags: ["work"]\n---\n[[Target]] ![file](assets/picture.png)\n`[[Target]]`'),
  "Target.md": strToU8("Target body"),
  "assets/picture.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
});

describe("additive import", () => {
  test("persists Markdown UUID navigation and fragments with explicit graph and heading warnings", async () => {
    // Given
    const bytes = zipSync({
      "Source.md": strToU8('[Read **target**](Target.md "title")\n\n[section](Target.md#section)'),
      "Target.md": strToU8("# section\n\nTarget body"),
    });
    const preview = await previewImport("markdown-links.zip", bytes);
    expect(preview.canCommit).toBe(true);
    expect(preview.warnings.map(({ code }) => code)).toEqual([
      "markdown_note_graph_unsupported", "unsupported_note_fragment",
    ]);
    // When
    const receipt = await commitImport("markdown-links.zip", bytes, preview.digest);
    // Then
    expect(receipt.warnings).toEqual(preview.warnings);
    const source = receipt.notes.find((note) => note.title === "Source");
    const target = receipt.notes.find((note) => note.title === "Target");
    if (!source || !target) throw new Error("Missing imported Markdown notes");
    expect((await getNote(source.id))?.body).toBe(
      `[Read **target**](/notes/${target.id} "title")\n\n[section](/notes/${target.id}#section)`,
    );
    expect((await getNoteLinks(source.id)).outgoing).toEqual([]);
  });

  test("preserves committed attachment bytes when the transaction response is lost", async () => {
    const bytes = archive();
    const preview = await previewImport("vault.zip", bytes);
    const transaction = database.tx;
    const lostResponse = spyOn(database, "tx").mockImplementation(async (callback) => {
      await transaction(callback);
      throw new Error("Synthetic lost commit response");
    });
    try {
      await expect(commitImport("vault.zip", bytes, preview.digest)).rejects.toThrow();
      const attachments = await query<{ storage_key: string }>("SELECT storage_key FROM attachments");
      expect(attachments).toHaveLength(1);
      const saved = attachments[0];
      if (!saved) throw new Error("Missing committed attachment");
      expect(new Uint8Array(await readFile(storagePath(saved.storage_key))))
        .toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    } finally {
      lostResponse.mockRestore();
    }
  });
  test("previews without writes and commits notes, aliases, links and attachment bytes", async () => {
    const bytes = archive();
    const preview = await previewImport("vault.zip", bytes);
    expect(preview.canCommit).toBe(true);
    expect(preview.notes).toHaveLength(2);
    expect(preview.attachments).toBe(1);
    expect((await query<{ count: number }>("SELECT count(*)::int AS count FROM notes"))[0]?.count).toBe(0);
    expect(await readdir(directory)).toEqual([]);

    const receipt = await commitImport("vault.zip", bytes, preview.digest);

    expect(receipt.status).toBe("imported");
    const source = receipt.notes.find((note) => note.title === "Start");
    const target = receipt.notes.find((note) => note.title === "Target");
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    if (!source || !target) throw new Error("Missing imported notes");
    expect(await getNote(source.id)).toMatchObject({ aliases: ["Beginning"], tags: ["work"] });
    expect((await getNoteLinks(source.id)).outgoing).toEqual([{ id: target.id, title: "Target" }]);
    const attachments = await query<{ id: string; storage_key: string }>("SELECT id,storage_key FROM attachments");
    expect(attachments).toHaveLength(1);
    const attachment = attachments[0];
    if (!attachment) throw new Error("Missing attachment");
    expect((await getNote(source.id))?.body).toContain(`/api/attachments/${attachment.id}`);
    expect((await getNote(source.id))?.body).toContain("`[[Target]]`");
    expect(new Uint8Array(await readFile(storagePath(attachment.storage_key))))
      .toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  test("refuses a repeat import without overwriting or duplicating files", async () => {
    const bytes = archive();
    const first = await previewImport("vault.zip", bytes);
    await commitImport("vault.zip", bytes, first.digest);
    const before = await query("SELECT id,title,body FROM notes ORDER BY id");
    const files = await readdir(directory);

    await expect(commitImport("vault.zip", bytes, first.digest)).rejects.toMatchObject({ code: "conflict" });

    expect(await query("SELECT id,title,body FROM notes ORDER BY id")).toEqual(before);
    expect(await readdir(directory)).toEqual(files);
    expect((await previewImport("vault.zip", bytes)).canCommit).toBe(false);
  });

  test("rejects stale previews after another writer creates a colliding title", async () => {
    const bytes = strToU8("New note");
    const preview = await previewImport("Collision.md", bytes);
    const existing = await createNote({ title: "Collision", body: "Keep me" });

    await expect(commitImport("Collision.md", bytes, preview.digest)).rejects.toMatchObject({ code: "conflict" });

    expect((await getNote(existing.id))?.body).toBe("Keep me");
    expect((await query<{ count: number }>("SELECT count(*)::int AS count FROM notes"))[0]?.count).toBe(1);
  });

  test("binds confirmation to exact bytes rather than client-supplied preview fields", async () => {
    const preview = await previewImport("Draft.md", strToU8("Reviewed"));

    await expect(commitImport("Draft.md", strToU8("Changed"), preview.digest)).rejects.toMatchObject({ code: "conflict" });

    expect((await query<{ count: number }>("SELECT count(*)::int AS count FROM notes"))[0]?.count).toBe(0);
  });

  test("blocks existing aliases, trash and duplicate incoming titles explicitly", async () => {
    const note = await createNote({ title: "Original" });
    await updateNote(note.id, { aliases: ["Old name"] });
    await trashNote(note.id);

    const alias = await previewImport("Old name.md", strToU8("No overwrite"));
    const duplicate = await previewImport("duplicate.zip", zipSync({
      "a/Same.md": strToU8("A"), "b/Same.md": strToU8("B"),
    }));

    expect(alias.canCommit).toBe(false);
    expect(alias.conflicts.length).toBeGreaterThan(0);
    expect(duplicate.canCommit).toBe(false);
    expect(duplicate.conflicts.length).toBeGreaterThan(0);
  });

  test("serializes simultaneous confirmed imports so only one can succeed", async () => {
    const bytes = strToU8("One copy");
    const preview = await previewImport("Concurrent.md", bytes);

    const results = await Promise.allSettled([
      commitImport("Concurrent.md", bytes, preview.digest),
      commitImport("Concurrent.md", bytes, preview.digest),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await query<{ count: number }>("SELECT count(*)::int AS count FROM notes"))[0]?.count).toBe(1);
  });

  test("rolls back notes, links and files after attachment metadata insertion fails", async () => {
    const bytes = archive();
    const preview = await previewImport("vault.zip", bytes);
    await query("ALTER TABLE attachments ADD CONSTRAINT import_test_reject CHECK (filename <> 'picture.png') NOT VALID");
    try {
      await expect(commitImport("vault.zip", bytes, preview.digest)).rejects.toMatchObject({
        code: "23514", constraint: "import_test_reject",
      });

      for (const table of ["notes", "links", "unresolved_links", "attachments"]) {
        expect((await query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`))[0]?.count).toBe(0);
      }
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await query("ALTER TABLE attachments DROP CONSTRAINT import_test_reject");
    }
  });

  test("imports current portable exports after fresh database reset", async () => {
    const target = await createNote({ title: "A/B", tags: ["work"] });
    await updateNote(target.id, { aliases: ["Former"] });
    const source = await createNote({ title: "Source", body: "[[Former]]" });
    const attachment = await saveAttachment(new File(["payload"], "diagram.png", { type: "image/png" }), source.id);
    await updateNote(source.id, { body: `[[Former]] ![diagram](/api/attachments/${attachment.id})` });
    const bytes = new Uint8Array(await (await exportResponse(new Date(), { wikiLinks: "portable" })).arrayBuffer());
    await resetData();
    const preview = await previewImport("export.zip", bytes);

    const receipt = await commitImport("export.zip", bytes, preview.digest);

    expect(receipt.notes).toHaveLength(2);
    expect(receipt.attachments).toBe(1);
    const importedSource = receipt.notes.find((note) => note.title === "Source");
    const importedTarget = receipt.notes.find((note) => note.title === "A/B");
    if (!importedSource || !importedTarget) throw new Error("Missing round-trip notes");
    expect((await getNoteLinks(importedSource.id)).outgoing).toEqual([{ id: importedTarget.id, title: "A/B" }]);
    expect((await getNote(importedTarget.id))?.aliases).toContain("Former");
  });

  test("shows missing attachments and unsupported metadata before any commit", async () => {
    const bytes = strToU8("---\ncustom: hello\n---\n![missing](missing.png)");

    const preview = await previewImport("Warnings.md", bytes);

    expect(preview.warnings.length).toBeGreaterThanOrEqual(2);
    expect((await query<{ count: number }>("SELECT count(*)::int AS count FROM notes"))[0]?.count).toBe(0);
  });
});
