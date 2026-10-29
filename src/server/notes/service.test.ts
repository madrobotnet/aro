import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { UNTITLED } from "@/server/i18n/copy";
import { query, tx } from "@/server/db";
import { closeDb, connectTestDatabase, resetData } from "@/server/test/db";
import { findNoteReference } from "./reference";
import {
  createNote,
  findNoteTitles,
  getNote,
  getNoteLinks,
  getOrCreateByTitle,
  getOrCreateDaily,
  listNotes,
  listTags,
  restoreNote,
  trashNote,
  updateNote,
} from "./service";

connectTestDatabase();
beforeEach(resetData);
afterAll(closeDb);

describe("note service", () => {
  test("reference reads preserve normalized archived alias ordering without creating notes", async () => {
    const older = await createNote({ title: "ÉTUDE  계획" });
    const newer = await createNote({ title: "old name" });
    await updateNote(older.id, { archived: true, aliases: ["Old  Name"] });
    await query("UPDATE notes SET created_at=$2 WHERE id=$1", [older.id, "2026-01-01T00:00:00Z"]);
    await query("UPDATE notes SET created_at=$2 WHERE id=$1", [newer.id, "2026-01-02T00:00:00Z"]);
    const before = await query<{ count: number }>("SELECT count(*)::int AS count FROM notes");

    const results = await Promise.all([" étude   계획 ", " OLD\tNAME ", "Missing"].map(findNoteReference));

    expect(results).toEqual([{ id: older.id, title: older.title }, { id: older.id, title: older.title }, null]);
    expect(await query("SELECT count(*)::int AS count FROM notes")).toEqual(before);
  });

  test("reference reads exclude trashed titles and aliases", async () => {
    const note = await createNote({ title: "Trashed" });
    await updateNote(note.id, { aliases: ["Hidden"] });
    await trashNote(note.id);

    const results = await Promise.all(["Trashed", "Hidden"].map(findNoteReference));

    expect(results).toEqual([null, null]);
    expect(await query("SELECT count(*)::int AS count FROM notes")).toEqual([{ count: 1 }]);
  });

  test("finds a renamed note by its preserved alias without returning archived notes", async () => {
    const note = await createNote({ title: "이전 제목" });
    await updateNote(note.id, { title: "Canonical name" });
    expect(await findNoteTitles("이전 제목")).toEqual([{ id: note.id, title: "Canonical name", matchedAlias: "이전 제목" }]);
    expect(await findNoteTitles("Canonical")).toEqual([{ id: note.id, title: "Canonical name", matchedAlias: null }]);
    await updateNote(note.id, { archived: true });
    expect(await findNoteTitles("이전 제목")).toEqual([]);
  });

  test("creates unique default titles, allows empty bodies, merges inline tags, and stores embeddings", async () => {
    const first = await createNote({ body: "메모 #생각", tags: ["생각", "Work"] });
    const second = await createNote({});

    expect(first.title).toBe("제목 없음");
    expect(first.tags).toEqual(["work", "생각"]);
    expect(second.title).toBe("제목 없음 2");
    expect(second.body).toBe("");
    const rows = await query<{ embedded: boolean; fresh: boolean }>(
      `SELECT search_embedding IS NOT NULL AS embedded,
         search_source_hash=md5(title || E'\\n' || body) AS fresh FROM notes WHERE id=$1`, [first.id],
    );
    expect(rows[0]?.embedded).toBe(true);
    expect(rows[0]?.fresh).toBe(true);
  });

  test("uses independent localized default-title collision sequences", async () => {
    const first = await createNote({}, undefined, "en");
    const second = await createNote({}, undefined, "en");
    const korean = await createNote({});
    expect([first.title, second.title, korean.title]).toEqual([UNTITLED.en, `${UNTITLED.en} 2`, UNTITLED.ko]);
  });

  test("resolves a wikilink, preserves it across rename, then hides and restores the backlink", async () => {
    const source = await createNote({ title: "출발", body: "앞 문장 [[목표|표시]] 뒤 문장" });
    expect((await getNoteLinks(source.id)).unresolved).toEqual(["목표"]);

    const target = await createNote({ title: "목표" });
    expect((await getNoteLinks(source.id)).outgoing).toEqual([{ id: target.id, title: "목표" }]);
    expect((await getNoteLinks(target.id)).backlinks[0]?.id).toBe(source.id);

    const renamed = await updateNote(target.id, { title: "새 목표" });
    expect(renamed.aliases).toContain("목표");
    expect((await getNoteLinks(source.id)).outgoing).toEqual([{ id: target.id, title: "새 목표" }]);

    await trashNote(target.id);
    expect((await getNoteLinks(source.id)).outgoing).toEqual([]);
    expect((await getNoteLinks(source.id)).unresolved).toEqual(["목표"]);

    await restoreNote(target.id);
    expect((await getNoteLinks(source.id)).outgoing).toEqual([{ id: target.id, title: "새 목표" }]);
    expect((await getNoteLinks(target.id)).backlinks[0]?.context).toContain("표시");
  });

  test("participates in a caller transaction and rolls back note and materialized links together", async () => {
    const target = await createNote({ title: "대상" });
    await expect(tx(async (client) => {
      await createNote({ title: "되돌림", body: "[[대상]]" }, client);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");

    expect(await findNoteTitles("되돌림")).toEqual([]);
    expect((await getNoteLinks(target.id)).backlinks).toEqual([]);
  });

  test("resolves an existing title containing repeated whitespace", async () => {
    const target = await createNote({ title: "독서  계획" });

    const source = await createNote({ body: "[[독서  계획]]" });

    expect((await getNoteLinks(source.id)).outgoing).toEqual([{ id: target.id, title: target.title }]);
    expect((await getNoteLinks(source.id)).unresolved).toEqual([]);
  });

  test("resolves a whitespace-normalized pending link when its target appears", async () => {
    const source = await createNote({ body: "[[독서  계획]]" });

    const target = await createNote({ title: "독서 계획" });

    expect((await getNoteLinks(target.id)).backlinks.map((note) => note.id)).toEqual([source.id]);
    expect((await getNoteLinks(source.id)).unresolved).toEqual([]);
  });

  test("reuses a whitespace-normalized title rather than duplicating its note", async () => {
    const original = await createNote({ title: "독서  계획" });

    const found = await getOrCreateByTitle("독서  계획");

    expect(found.id).toBe(original.id);
    expect((await listNotes({})).notes).toHaveLength(1);
  });

  test("daily note get-or-create is idempotent under concurrent requests", async () => {
    const notes = await Promise.all(Array.from({ length: 6 }, () => getOrCreateDaily("2026-09-27")));
    expect(new Set(notes.map((note) => note.id)).size).toBe(1);
    expect(notes[0]?.dailyDate).toBe("2026-09-27");
    const rows = await query<{ count: number }>("SELECT count(*)::int AS count FROM notes WHERE daily_date='2026-09-27'");
    expect(rows[0]?.count).toBe(1);
  });

  test("creating a daily note resolves existing links to its date title", async () => {
    const source = await createNote({ title: "주간 계획", body: "[[2026-09-28]]에 돌아보기" });
    const daily = await getOrCreateDaily("2026-09-28");
    expect((await getNoteLinks(daily.id)).backlinks.map((note) => note.id)).toEqual([source.id]);
    expect((await getNoteLinks(source.id)).unresolved).toEqual([]);
  });

  test("restoring a replaced daily note reports conflict without losing either note", async () => {
    const original = await getOrCreateDaily("2026-09-28");
    await trashNote(original.id);
    const replacement = await getOrCreateDaily("2026-09-28");
    await expect(restoreNote(original.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await getNote(original.id))?.deletedAt).not.toBeNull();
    expect((await getNote(replacement.id))?.deletedAt).toBeNull();
  });

  test("lists pinned, archived, trash, cursor pages, title matches, and tag counts", async () => {
    const first = await createNote({ title: "첫 노트", tags: ["공통"] });
    const pinned = await createNote({ title: "고정 노트", tags: ["공통", "고정"] });
    await updateNote(pinned.id, { pinned: true });
    const archived = await createNote({ title: "보관 노트", tags: ["공통"] });
    await updateNote(archived.id, { archived: true });
    await trashNote(first.id);

    expect((await listNotes({ pinned: true })).notes.map((note) => note.id)).toEqual([pinned.id]);
    expect((await listNotes({ archived: true })).notes.map((note) => note.id)).toEqual([archived.id]);
    expect((await listNotes({ trash: true })).notes.map((note) => note.id)).toEqual([first.id]);
    const page = await listNotes({ limit: 1, archived: true });
    expect(page.notes).toHaveLength(1);
    expect((await findNoteTitles("고정"))[0]?.id).toBe(pinned.id);
    expect(await listTags()).toEqual([
      { tag: "공통", count: 2 },
      { tag: "고정", count: 1 },
    ]);
  });

  test("title get-or-create is case-insensitive and concurrency-safe", async () => {
    const notes = await Promise.all(Array.from({ length: 4 }, () => getOrCreateByTitle("  원자적 제목  ")));
    expect(new Set(notes.map((note) => note.id)).size).toBe(1);
    expect((await getOrCreateByTitle("원자적 제목")).id).toBe(notes[0]!.id);
  });

  test("pages every note when update timestamps share the same millisecond", async () => {
    const notes = [];
    for (const micros of ["123900", "123800", "123700"]) {
      const note = await createNote({ title: `정밀도 ${micros}` });
      await query("UPDATE notes SET updated_at=$2::timestamptz WHERE id=$1", [
        note.id, `2026-09-27T12:00:00.${micros}Z`,
      ]);
      notes.push(note);
    }

    const found: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = await listNotes({ limit: 1, cursor });
      found.push(...result.notes.map((note) => note.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(found).toEqual(notes.map((note) => note.id));
  });

  test("rejects malformed identifiers before querying postgres", async () => {
    await expect(getNote("../notes")).rejects.toMatchObject({ code: "validation" });
    await expect(getNote("not-a-uuid")).rejects.toMatchObject({ code: "validation" });
  });
});
