import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { relatedNotes, searchNotes } from "./service";

const directory = await mkdtemp(join(tmpdir(), "aro-search-sqlite-"));
const oldMode = process.env.ARO_DATABASE_MODE;
const oldPath = process.env.ARO_SQLITE_PATH;
beforeEach(async () => {
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "search.sqlite");
  (await sqliteStore()).run("DELETE FROM notes");
});
afterAll(async () => {
  await closeSQLiteStore();
  if (oldMode === undefined) delete process.env.ARO_DATABASE_MODE;
  else process.env.ARO_DATABASE_MODE = oldMode;
  if (oldPath === undefined) delete process.env.ARO_SQLITE_PATH;
  else process.env.ARO_SQLITE_PATH = oldPath;
  await rm(directory, { recursive: true, force: true });
});

test("finds Korean content and Unicode aliases without a model", async () => {
  const store = await sqliteStore();
  store.run("INSERT INTO notes(title,body,aliases,tags) VALUES (?,?,?,?)",
    ["독서", "지식을 연결하는 방법", '["CAFÉ"]', '["research"]']);
  expect((await searchNotes("지식")).hits.map(hit => hit.title)).toEqual(["독서"]);
  expect((await searchNotes("café", { tag: "research" })).hits.map(hit => hit.title)).toEqual(["독서"]);
  expect((await searchNotes("café", { tag: "other" })).hits).toHaveLength(0);
  expect((await searchNotes("지식")).semanticIndex?.state).toBe("disabled");
});

test("excludes archived and trashed notes and ranks exact titles first", async () => {
  const store = await sqliteStore();
  store.run("INSERT INTO notes(title,body) VALUES (?,?)", ["Reference", "Aro notes"]);
  store.run("INSERT INTO notes(title,body) VALUES (?,?)", ["Aro", "Exact"]);
  store.run("INSERT INTO notes(title,body,status) VALUES (?,?,?)", ["Hidden", "Aro", "archived"]);
  store.run("INSERT INTO notes(title,body,deleted_at) VALUES (?,?,?)",
    ["Trash", "Aro", "2026-10-12T00:00:00.000000Z"]);
  expect((await searchNotes("Aro", { limit: 1 })).hits.map(hit => hit.title)).toEqual(["Aro"]);
  expect((await searchNotes("Aro")).hits).toHaveLength(2);
});

test("search scans beyond one batch and retains only requested top hits", async () => {
  const store = await sqliteStore();
  store.transaction(tx => {
    for (let index = 0; index < 205; index++) {
      tx.run("INSERT INTO notes(title,body) VALUES (?,?)", [`Entry ${index}`, "shared"]);
    }
    tx.run("INSERT INTO notes(title,body) VALUES (?,?)", ["shared", "exact target"]);
  });
  const result = await searchNotes("shared", { limit: 3 });
  expect(result.hits).toHaveLength(3);
  expect(result.hits[0]?.title).toBe("shared");
  expect(result.semanticIndex?.totalNotes).toBe(206);
});

test("related notes compare real content and reject absent sources", async () => {
  const store = await sqliteStore();
  const source = store.get<{ id: string }>("INSERT INTO notes(title,body) VALUES (?,?) RETURNING id",
    ["Gardening", "tomato garden soil"]);
  if (!source) throw new Error("Missing fixture");
  store.run("INSERT INTO notes(title,body) VALUES (?,?)", ["Garden", "tomato garden soil"]);
  expect((await relatedNotes(source.id)).map(note => note.title)).toContain("Garden");
  await expect(relatedNotes(crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
});
