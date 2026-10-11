import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore } from "@/server/db/backend";
import { connectTestDatabase, resetData, closeDb } from "@/server/test/db";
import { createNote, getNote, getNoteLinks, updateNote } from "@/server/notes/service";
import { saveAttachment } from "@/server/notes/attachments";
import { storagePath } from "@/server/notes/attachment-storage";
import { exportResponse } from "@/server/export/service";
import { commitImport, previewImport } from "./service";

test("portable note transfer preserves aliases links and files across PostgreSQL SQLite PostgreSQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-cross-transfer-"));
  const previous = { ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE, ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH,
    ATTACHMENTS_DIR: process.env.ATTACHMENTS_DIR };
  process.env.ARO_DATABASE_MODE = "postgres";
  process.env.ATTACHMENTS_DIR = join(directory, "attachments");
  connectTestDatabase();
  try {
    await resetData();
    const target = await createNote({ title: "대상", tags: ["transfer"] });
    await updateNote(target.id, { aliases: ["Target alias"] });
    const source = await createNote({ title: "Source" });
    const attachment = await saveAttachment(new File(["cross-backend-bytes"], "proof.txt"), source.id);
    await updateNote(source.id, { body: `[[Target alias]]\n[proof](/api/attachments/${attachment.id})` });
    const fromPostgres = new Uint8Array(await (await exportResponse(new Date(), { wikiLinks: "portable" })).arrayBuffer());

    process.env.ARO_DATABASE_MODE = "sqlite";
    process.env.ARO_SQLITE_PATH = join(directory, "target.sqlite");
    const preview = await previewImport("postgres.zip", fromPostgres);
    const first = await commitImport("postgres.zip", fromPostgres, preview.digest);
    const nativeSource = first.notes.find(note => note.title === "Source");
    const nativeTarget = first.notes.find(note => note.title === "대상");
    if (!nativeSource || !nativeTarget) throw new Error("Native import omitted notes");
    expect((await getNote(nativeTarget.id))?.aliases).toContain("Target alias");
    expect((await getNoteLinks(nativeSource.id)).outgoing.map(note => note.id)).toEqual([nativeTarget.id]);
    const nativeBody = (await getNote(nativeSource.id))?.body ?? "";
    const nativeAttachment = /\/api\/attachments\/([a-f0-9-]+)/.exec(nativeBody)?.[1];
    if (!nativeAttachment) throw new Error("Native import omitted attachment reference");
    expect(await readFile(storagePath(nativeAttachment), "utf8")).toBe("cross-backend-bytes");
    const fromSQLite = new Uint8Array(await (await exportResponse()).arrayBuffer());

    process.env.ARO_DATABASE_MODE = "postgres";
    await resetData();
    const returnPreview = await previewImport("sqlite.zip", fromSQLite);
    const back = await commitImport("sqlite.zip", fromSQLite, returnPreview.digest);
    const returnedSource = back.notes.find(note => note.title === "Source");
    const returnedTarget = back.notes.find(note => note.title === "대상");
    if (!returnedSource || !returnedTarget) throw new Error("Return import omitted notes");
    expect((await getNoteLinks(returnedSource.id)).outgoing.map(note => note.id)).toEqual([returnedTarget.id]);
    expect((await getNote(returnedTarget.id))?.tags).toEqual(["transfer"]);
    expect(back.attachments).toBe(1);
  } finally {
    await closeSQLiteStore();
    await closeDb();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
