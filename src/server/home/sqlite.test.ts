import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { createNote, getOrCreateDaily, updateNote } from "@/server/notes/service";
import { getHomeData } from "./service";

test("SQLite home combines real note, daily, tag and inbox data without a model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-home-"));
  const previous = { ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE, ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH };
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "home.sqlite");
  try {
    const reference = await createNote({ title: "Reference", tags: ["work"] });
    const linked = await createNote({ title: "Linked", body: "[[Reference]]" });
    await updateNote(linked.id, { pinned: true });
    const daily = await getOrCreateDaily("2026-10-12");
    const store = await sqliteStore();
    store.run("UPDATE notes SET updated_at=? WHERE id=?", ["2026-09-01T00:00:00.000000Z", reference.id]);
    store.run("INSERT INTO inbox_items(title,body,source) VALUES (?,?,?)", ["Inbox", "Draft", "web"]);
    const options = { now: new Date("2026-10-12T10:00:00Z"), timeZone: "UTC" };
    const home = await getHomeData(options);
    expect(home.stats).toEqual({ notes: 3, links: 1, tags: 1 });
    expect(home.daily?.id).toBe(daily.id);
    expect(home.inboxCount).toBe(1);
    expect(home.pinned.map(note => note.id)).toEqual([linked.id]);
    expect(home.resurface.map(note => note.id)).toEqual([reference.id]);
    expect((await getHomeData(options)).resurface).toEqual(home.resurface);
  } finally {
    await closeSQLiteStore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
