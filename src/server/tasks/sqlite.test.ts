import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { createNote, getNote, updateNote } from "@/server/notes/service";
import { listTasks, toggleNoteTask } from "./service";

test("SQLite tasks exclude code and archives, record toggles and reject stale text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-tasks-"));
  const previous = { ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE, ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH };
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "tasks.sqlite");
  try {
    const note = await createNote({ title: "Todo", body: "- [ ] one\n```\n- [ ] code\n```" });
    const archived = await createNote({ title: "Hidden", body: "- [ ] hidden" });
    await updateNote(archived.id, { archived: true });
    expect((await listTasks("open")).tasks.map(item => item.text)).toEqual(["one"]);
    await expect(toggleNoteTask({ noteId: note.id, line: 1, expectedText: "stale", done: true }))
      .rejects.toMatchObject({ code: "conflict", extra: { reason: "mismatch" } });
    expect((await getNote(note.id))?.body).toBe(note.body);
    const changed = await toggleNoteTask({ noteId: note.id, line: 1, expectedText: "one", done: true });
    expect(changed.note.body).toBe("- [x] one\n```\n- [ ] code\n```");
    expect((await listTasks("done")).tasks.map(item => item.text)).toEqual(["one"]);
    expect((await sqliteStore()).all("SELECT reason FROM note_revisions WHERE note_id=?", [note.id]))
      .toEqual([{ reason: "task-toggle" }]);
  } finally {
    await closeSQLiteStore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
