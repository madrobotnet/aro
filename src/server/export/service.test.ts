import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { db, query } from "@/server/db";
import { ApiError } from "@/server/http";
import { saveAttachment } from "@/server/notes/attachments";
import { storagePath } from "@/server/notes/attachment-storage";
import { createNote, getOrCreateDaily, trashNote, updateNote } from "@/server/notes/service";
import { closeDb, connectTestDatabase, resetData } from "@/server/test/db";
import { exportResponse } from "./service";

connectTestDatabase();
const directory = await mkdtemp(path.join(os.tmpdir(), "sb-export-"));
process.env.ATTACHMENTS_DIR = directory;
beforeEach(resetData);
afterAll(async () => {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});

async function unzip(response: Response): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await response.arrayBuffer()));
}
function frontMatterOf(markdown: string): unknown {
  return Bun.YAML.parse(markdown.slice(4, markdown.indexOf("\n---\n")));
}
function manifestOf(entries: Record<string, Uint8Array>): {
  wikiLinks: string;
  notes: { id: string; path: string }[];
  attachments: { id: string; path: string }[];
  omittedAttachments: { id: string; reason: string }[];
} {
  return JSON.parse(strFromU8(entries["export-manifest.json"]!));
}

/** Subscribe before starting export; release only after the concurrent change finishes. */
function holdOpen(filePath: string) {
  let entered = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = fs.open;
  let heldHandle: fs.FileHandle | undefined;
  const mock = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (file === filePath) {
      entered();
      await gate;
    }
    const handle = await original(file, flags, mode);
    if (file === filePath) heldHandle = handle;
    return handle;
  });
  return { reached, release, restore: () => mock.mockRestore(), descriptor: () => heldHandle?.fd };
}

describe("markdown export", () => {
  test("zips active and archived notes with front matter and their attachments, skipping trash", async () => {
    const first = await createNote({ title: "회의", tags: ["work"] });
    const image = await saveAttachment(new File(["PNG-BYTES"], "diagram.png", { type: "image/png" }), first.id);
    const lost = await saveAttachment(new File(["gone"], "lost.txt", { type: "text/plain" }), first.id);
    await unlink(storagePath(lost.storageKey));
    const body = `![diagram](/api/attachments/${image.id})\n[[회의|같은 제목]] [lost](/api/attachments/${lost.id})`;
    await updateNote(first.id, { body });
    const second = await createNote({ title: "회의", body: "보관한 노트" });
    await updateNote(second.id, { archived: true });
    await createNote({ title: "A/B: test?" });
    await getOrCreateDaily("2026-09-30");
    const trashed = await createNote({ title: "버린 노트" });
    await saveAttachment(new File(["secret"], "trash.png", { type: "image/png" }), trashed.id);
    await trashNote(trashed.id);
    await saveAttachment(new File(["loose"], "unreferenced.png", { type: "image/png" }));

    const response = await exportResponse(new Date("2026-09-30T23:59:00.000Z"));
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=irang-export-2026-09-30.zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const entries = await unzip(response);

    expect(Object.keys(entries).sort()).toEqual([
      "attachments/diagram.png", "export-manifest.json", "notes/2026-09-30.md", "notes/A-B- test-.md", "notes/회의-2.md", "notes/회의.md",
    ]);
    expect(manifestOf(entries).omittedAttachments).toEqual([{ id: lost.id, reason: "file_missing" }]);
    expect(manifestOf(entries).wikiLinks).toBe("preserve");
    expect(strFromU8(entries["attachments/diagram.png"]!)).toBe("PNG-BYTES");
    const markdown = strFromU8(entries["notes/회의.md"]!);
    expect(markdown.slice(markdown.indexOf("\n---\n") + 5)).toBe(
      `![diagram](../attachments/diagram.png)\n[[회의|같은 제목]] [lost](/api/attachments/${lost.id})`,
    );
    expect(frontMatterOf(markdown)).toMatchObject({ id: first.id, title: "회의", tags: ["work"], archived: false });
    expect(frontMatterOf(strFromU8(entries["notes/회의-2.md"]!))).toMatchObject({ id: second.id, archived: true });
    expect(frontMatterOf(strFromU8(entries["notes/2026-09-30.md"]!))).toMatchObject({ daily_date: "2026-09-30" });
  });

  test("pages through notes that share one creation time without skipping or repeating any", async () => {
    await query("INSERT INTO notes (title,body) SELECT 'note ' || g, '' FROM generate_series(1,250) g");
    const names = Object.keys(await unzip(await exportResponse()));
    expect(names).toHaveLength(251);
    expect(new Set(names).size).toBe(251);
  });

  test("produces a valid empty archive when there are no notes", async () => {
    const entries = await unzip(await exportResponse());
    expect(Object.keys(entries)).toEqual(["export-manifest.json"]);
    expect(manifestOf(entries)).toMatchObject({ notes: [], attachments: [], omittedAttachments: [] });
  });

  test("holds one snapshot through concurrent edits, later pages and an attachment purge", async () => {
    const first = await createNote({ title: "Before" });
    const blocker = await saveAttachment(new File(["kept"], "kept.txt"), first.id);
    const victim = await saveAttachment(new File(["purged"], "victim.txt"), first.id);
    const body = `[kept](/api/attachments/${blocker.id}) [victim](/api/attachments/${victim.id}) [[Before]]`;
    await updateNote(first.id, { body });
    await query("INSERT INTO notes (title,body) SELECT 'page ' || g, 'old body' FROM generate_series(1,205) g");
    const hold = holdOpen(storagePath(blocker.storageKey));
    try {
      const response = await exportResponse();
      await hold.reached;
      await updateNote(first.id, { title: "After", body: "new body" });
      await query("UPDATE notes SET body='edited page' WHERE title LIKE 'page %'");
      await createNote({ title: "Late note" });
      await query("DELETE FROM attachments WHERE id=$1", [victim.id]);
      await unlink(storagePath(victim.storageKey));
      hold.release();
      const entries = await unzip(response);
      expect(strFromU8(entries["notes/Before.md"]!)).toContain(
        `[kept](../attachments/kept.txt) [victim](/api/attachments/${victim.id}) [[Before]]`,
      );
      expect(entries["notes/After.md"]).toBeUndefined();
      expect(entries["notes/Late note.md"]).toBeUndefined();
      const pages = Object.entries(entries).filter(([name]) => name.startsWith("notes/page "));
      expect(pages).toHaveLength(205);
      for (const [, bytes] of pages) expect(strFromU8(bytes)).toContain("old body");
      expect(manifestOf(entries).notes).toHaveLength(206);
      expect(manifestOf(entries).attachments).toEqual([{ id: blocker.id, path: "attachments/kept.txt" }]);
      expect(manifestOf(entries).omittedAttachments).toEqual([{ id: victim.id, reason: "purge_race" }]);
    } finally {
      hold.release();
      hold.restore();
    }
  });

  test("reports references whose attachment metadata is already absent", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    await createNote({ title: "Missing", body: `[missing](/api/attachments/${id})` });
    const entries = await unzip(await exportResponse());
    expect(manifestOf(entries).omittedAttachments).toEqual([{ id, reason: "metadata_missing" }]);
    expect(strFromU8(entries["notes/Missing.md"]!)).toContain(`/api/attachments/${id}`);
  });

  test("portable mode maps aliases and sanitized collisions to actual filenames", async () => {
    const first = await createNote({ title: "A/B" });
    await updateNote(first.id, { aliases: ["old name"] });
    const second = await createNote({ title: "A:B" });
    const source = await createNote({ title: "source", body: "[[old name#Heading|Label]] [[A:B]] [[missing]] `[[A/B]]`" });
    const entries = await unzip(await exportResponse(new Date(), { wikiLinks: "portable" }));
    expect(strFromU8(entries["notes/source.md"]!)).toContain(
      "[[A-B.md#Heading|Label]] [[A-B-2.md|A:B]] [[missing]] `[[A/B]]`",
    );
    expect(manifestOf(entries).notes).toEqual([
      expect.objectContaining({ id: first.id, path: "notes/A-B.md" }),
      expect.objectContaining({ id: second.id, path: "notes/A-B-2.md" }),
      expect.objectContaining({ id: source.id, path: "notes/source.md" }),
    ]);
    expect(manifestOf(entries).wikiLinks).toBe("portable");
  });

  test("portable duplicate ties use IDs and wiki delimiters in filenames are sanitized", async () => {
    const older = "00000000-0000-4000-8000-000000000001";
    const newer = "00000000-0000-4000-8000-000000000002";
    const source = "00000000-0000-4000-8000-000000000003";
    await query(
      `INSERT INTO notes (id,title,body,created_at,aliases) VALUES
       ($2,'dup','','2026-10-01',ARRAY['old name']),
       ($1,'Dup','[[Dup]]','2026-10-01',ARRAY['old name']),
       ($3,'Hash# [name]','[[ OLD   NAME#Part|Label]]','2026-10-01',ARRAY['safe alias'])`,
      [older, newer, source],
    );
    const entries = await unzip(await exportResponse(new Date(), { wikiLinks: "portable" }));
    expect(manifestOf(entries).notes).toEqual([
      expect.objectContaining({ id: older, path: "notes/Dup.md" }),
      expect.objectContaining({ id: newer, path: "notes/dup-2.md" }),
      expect.objectContaining({ id: source, path: "notes/Hash- -name-.md" }),
    ]);
    expect(strFromU8(entries["notes/Dup.md"]!)).toContain("[[dup-2.md|Dup]]");
    expect(strFromU8(entries["notes/Hash- -name-.md"]!)).toContain("[[Dup.md#Part|Label]]");
  });

  test("unexpected attachment IO errors fail the stream and release its connection", async () => {
    const note = await createNote({ title: "IO failure" });
    await saveAttachment(new File(["bytes"], "io.txt"), note.id);
    const pool = await db();
    const before = pool.totalCount - pool.idleCount;
    const mock = spyOn(fs, "open").mockRejectedValueOnce(new ApiError("internal", "disk failure"));
    try {
      const response = await exportResponse();
      await expect(response.arrayBuffer()).rejects.toThrow("disk failure");
      expect(pool.totalCount - pool.idleCount).toBe(before);
    } finally {
      mock.mockRestore();
    }
  });

  test("cancelling a paused export releases its snapshot connection and file descriptor", async () => {
    const note = await createNote({ title: "Cancel" });
    const attachment = await saveAttachment(new File(["bytes"], "cancel.txt"), note.id);
    const pool = await db();
    const before = pool.totalCount - pool.idleCount;
    const hold = holdOpen(storagePath(attachment.storageKey));
    try {
      const response = await exportResponse();
      await hold.reached;
      const cancelled = response.body!.cancel();
      hold.release();
      await cancelled;
      expect(pool.totalCount - pool.idleCount).toBe(before);
      expect(hold.descriptor()).toBe(-1);
    } finally {
      hold.release();
      hold.restore();
    }
  });
});
