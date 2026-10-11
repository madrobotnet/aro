import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { openSQLite, sqliteTimestamp, type SQLiteStore } from "@/server/db/sqlite";
import { embedText } from "@/lib/embed";
import { loadAttachment, MAX_ATTACHMENT_BYTES, saveAttachment } from "./attachments";
import { retryAttachmentCleanup } from "./attachment-cleanup";
import { linkMention } from "./mentions";
import { getRevision, listRevisions, restoreRevision } from "./revisions";
import {
  createNote, findNoteTitles, getNote, getNoteLinks, getOrCreateByTitle, getOrCreateDaily,
  listNotes, listTags, purgeNote, restoreNote, trashNote, updateNote,
} from "./service";
import { createSQLiteNote, pruneSQLiteRevisions, purgeSQLiteNote, updateSQLiteNote } from "./sqlite";
import { emptyTrash, purgeExpired, runNoteMaintenance } from "./trash";

const original = {
  ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE,
  ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH,
  ATTACHMENTS_DIR: process.env.ATTACHMENTS_DIR,
};
let directory: string;
let store: SQLiteStore;
beforeEach(async () => {
  await closeSQLiteStore();
  directory = await mkdtemp(path.join(tmpdir(), "aro-notes-sqlite-"));
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = path.join(directory, "notes.sqlite");
  process.env.ATTACHMENTS_DIR = path.join(directory, "attachments");
  store = await sqliteStore();
});
afterEach(async () => {
  await closeSQLiteStore();
  await rm(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const filePath = (key: string): string => path.join(directory, "attachments", key);
const old = (days: number): string => sqliteTimestamp(new Date(Date.now() - days * 86400_000));

test("native CRUD normalizes UUIDs, titles, tags, aliases and persists through reopen", async () => {
  const note = await createNote({ body: "body #생각", tags: ["Work", "생각"], sourceUrl: "https://example.test" });
  const second = await createNote({});
  const english = await createNote({}, undefined, "en");
  expect([note.title, second.title, english.title]).toEqual(["제목 없음", "제목 없음 2", "Untitled"]);
  expect(note.tags).toEqual(["work", "생각"]);
  const updated = await updateNote(note.id.toUpperCase(), {
    title: " ÉTUDE  계획 ", aliases: [" Alias  하나 ", "alias 하나", "étude 계획"], pinned: true,
  });
  expect(updated.aliases).toEqual(["alias 하나", "제목 없음"]);
  expect(updated.title).toBe("ÉTUDE  계획");
  expect(updated.sourceUrl).toBe("https://example.test");
  const cache = store.get<{ search_embedding: string; search_source_hash: string }>("SELECT search_embedding,search_source_hash FROM notes WHERE id=?", [note.id]);
  expect(cache && JSON.parse(cache.search_embedding)).toEqual(embedText(`${updated.title}\n${updated.body}`));
  await closeSQLiteStore();
  expect(await getNote(note.id.toUpperCase())).toEqual(updated);
  await expect(getNote("../bad")).rejects.toMatchObject({ code: "validation" });
  await expect(updateNote(note.id, { title: " " })).rejects.toMatchObject({ code: "validation" });
});

test("caller SQLite transactions roll back notes, revisions, links and queued cleanup atomically", async () => {
  const target = await createNote({ title: "대상" });
  expect(() => store.transaction((q) => {
    const created = createSQLiteNote(q, { title: "rollback", body: "[[대상]]" });
    updateSQLiteNote(q, target.id.toUpperCase(), { title: "changed" });
    q.run("UPDATE notes SET deleted_at=? WHERE id=?", [old(1), created.id]);
    q.run("INSERT INTO attachments(note_id,filename,mime,size_bytes,storage_key) VALUES (?,'x','text/plain',1,?)", [created.id, randomUUID()]);
    purgeSQLiteNote(q, created.id, "trashed");
    throw new Error("rollback");
  })).toThrow("rollback");
  expect((await getNote(target.id))?.title).toBe("대상");
  expect(await findNoteTitles("rollback")).toEqual([]);
  expect(await listRevisions(target.id)).toEqual([]);
  expect((await getNoteLinks(target.id)).backlinks).toEqual([]);
  expect(store.all("SELECT * FROM attachment_cleanup")).toEqual([]);
});

test("Unicode and whitespace title/alias resolution survives rename, trash and restore", async () => {
  const source = await createNote({ title: "출발", body: "앞 [[étude  계획|표시]] 뒤 #Work" });
  expect((await getNoteLinks(source.id)).unresolved).toEqual(["étude  계획"]);
  const target = await createNote({ title: "ÉTUDE 계획" });
  expect((await getNoteLinks(source.id)).outgoing).toEqual([{ id: target.id, title: target.title }]);
  await updateNote(target.id, { title: "새 이름" });
  expect(await findNoteTitles("ÉTUDE")).toEqual([{ id: target.id, title: "새 이름", matchedAlias: "ÉTUDE 계획" }]);
  expect((await getOrCreateByTitle("étude   계획")).id).toBe(target.id);
  await trashNote(target.id);
  expect((await getNoteLinks(source.id)).unresolved).toEqual(["étude  계획"]);
  await expect(updateNote(target.id, { body: "no" })).rejects.toMatchObject({ code: "conflict" });
  await restoreNote(target.id);
  expect((await getNoteLinks(target.id)).backlinks[0]?.context).toContain("표시");
  const later = await createNote({ body: "[[étude 계획]]" });
  expect((await getNoteLinks(later.id)).outgoing[0]?.id).toBe(target.id);
  await expect(restoreNote(source.id)).rejects.toMatchObject({ code: "not_found" });
});

test("canonical titles take precedence over aliases and links deduplicate normalized names", async () => {
  const alias = await createNote({ title: "old" });
  await updateNote(alias.id, { aliases: ["같은 이름"] });
  const target = await createNote({ title: "같은  이름" });
  const source = await createNote({ body: "[[같은 이름]] [[같은  이름]] [[missing]] [[missing]]" });
  expect((await getNoteLinks(source.id)).outgoing).toEqual([{ id: target.id, title: target.title }]);
  expect((await getNoteLinks(source.id)).unresolved).toEqual(["missing"]);
  await updateNote(source.id, { body: "" });
  expect((await getNoteLinks(source.id)).outgoing).toEqual([]);
});

test("daily notes and normalized titles serialize concurrent get-or-create with one template application", async () => {
  store.run("INSERT INTO note_templates(name,body,is_daily_default) VALUES ('daily',?,1)", ["# {{date}}\n#daily [[주간 계획]]"]);
  const weekly = await createNote({ title: "주간 계획" });
  const notes = await Promise.all(Array.from({ length: 6 }, () => getOrCreateDaily("2026-09-29")));
  expect(new Set(notes.map((note) => note.id)).size).toBe(1);
  const daily = notes[0];
  if (!daily) throw new Error("Missing daily");
  expect(daily.body).toBe("# 2026-09-29\n#daily [[주간 계획]]");
  expect(daily.tags).toEqual(["daily"]);
  expect((await getNoteLinks(weekly.id)).backlinks[0]?.id).toBe(daily.id);
  await updateNote(daily.id, { body: "manual" });
  expect((await getOrCreateDaily("2026-09-29")).body).toBe("manual");
  const titles = await Promise.all(["ÉTUDE", "étude", " étude "].map(getOrCreateByTitle));
  expect(new Set(titles.map((note) => note.id)).size).toBe(1);
  await trashNote(daily.id);
  const replacement = await getOrCreateDaily("2026-09-29");
  await expect(restoreNote(daily.id)).rejects.toMatchObject({ code: "conflict" });
  expect((await getNote(daily.id))?.deletedAt).not.toBeNull();
  expect((await getNote(replacement.id))?.deletedAt).toBeNull();
});

test("lists filters, Unicode LIKE wildcards, autocomplete exact priority and archived tag counts", async () => {
  const first = await createNote({ title: "ÉTUDE", tags: ["Work"] });
  const second = await createNote({ title: "ÉTUDE 2", tags: ["Work", "other"] });
  const third = await createNote({ title: "Trash", tags: ["other"] });
  await updateNote(first.id, { pinned: true });
  await updateNote(second.id, { archived: true });
  await trashNote(third.id);
  expect((await listNotes({ q: "ét_de", pinned: true, tag: "WORK" })).notes.map((note) => note.id)).toEqual([first.id]);
  expect((await listNotes({ archived: true })).notes.map((note) => note.id)).toEqual([second.id]);
  expect((await listNotes({ trash: true })).notes.map((note) => note.id)).toEqual([third.id]);
  expect(await findNoteTitles("étude")).toEqual([{ id: first.id, title: "ÉTUDE", matchedAlias: null }]);
  expect(await listTags()).toEqual([{ tag: "work", count: 2 }, { tag: "other", count: 1 }]);
  await updateNote(second.id, { archived: false });
  expect((await findNoteTitles("étude"))[0]?.id).toBe(first.id);
});

test("cursor keeps microseconds and UUID ties without gaps or repeats", async () => {
  const ids = [
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000001",
  ];
  store.transaction((q) => {
    ids.forEach((id, index) => q.run("INSERT INTO notes(id,title,body,updated_at) VALUES (?,'cursor','',?)",
      [id, index === 2 ? "2026-09-27T12:00:00.123700Z" : "2026-09-27T12:00:00.123900Z"]));
  });
  let cursor: string | undefined;
  const found: string[] = [];
  for (let page = 0; page < 4; page += 1) {
    const result = await listNotes({ limit: 1, cursor });
    found.push(...result.notes.map((note) => note.id));
    if (!result.nextCursor) break;
    const decoded = JSON.parse(Buffer.from(result.nextCursor, "base64url").toString("utf8"));
    expect(decoded.updatedAt).toBe("2026-09-27T12:00:00.123900Z");
    cursor = result.nextCursor;
  }
  expect(found).toEqual(ids);
  await expect(listNotes({ cursor: "garbage" })).rejects.toMatchObject({ code: "validation" });
});

test("revision coalescing, no-content updates, aging, restore and Unicode body length", async () => {
  const target = await createNote({ title: "대상" });
  const note = await createNote({ title: "original", body: "[[대상]] 🌱" });
  await updateNote(note.id, { pinned: true });
  expect(await listRevisions(note.id)).toEqual([]);
  await updateNote(note.id, { title: "changed", body: "v2" });
  await updateNote(note.id, { body: "v3" });
  const revisions = await listRevisions(note.id.toUpperCase());
  expect(revisions).toHaveLength(1);
  const first = revisions[0];
  if (!first) throw new Error("Missing revision");
  expect(first.bodyLength).toBe(Array.from(note.body).length);
  store.run("UPDATE note_revisions SET created_at=? WHERE id=?", [old(1), first.id]);
  await updateNote(note.id, { body: "v4" });
  expect(await listRevisions(note.id)).toHaveLength(2);
  const restored = await restoreRevision(note.id, first.id.toUpperCase());
  expect(restored.title).toBe("original");
  expect(restored.aliases).toContain("changed");
  expect((await getNoteLinks(target.id)).backlinks[0]?.id).toBe(note.id);
  const undo = (await listRevisions(note.id)).find((revision) => revision.reason === "restore");
  if (!undo) throw new Error("Missing restore snapshot");
  expect((await getRevision(note.id, undo.id)).body).toBe("v4");
  await expect(getRevision(target.id, first.id)).rejects.toMatchObject({ code: "not_found" });
  await trashNote(note.id);
  await expect(restoreRevision(note.id, first.id)).rejects.toMatchObject({ code: "conflict" });
  await purgeNote(note.id);
  expect(store.all("SELECT id FROM note_revisions WHERE note_id=?", [note.id])).toEqual([]);
});

test("revision retention caps at 50 and always keeps an idle note's newest aged snapshot", async () => {
  const edited = await createNote({ title: "edited", body: "current" });
  const idle = await createNote({ title: "idle" });
  store.transaction((q) => {
    for (let index = 1; index <= 60; index += 1) {
      q.run("INSERT INTO note_revisions(note_id,title,body,created_at) VALUES (?,'x',?,?)",
        [edited.id, `old ${index}`, sqliteTimestamp(new Date(Date.now() - index * 3600_000))]);
    }
    for (let index = 1; index <= 3; index += 1) {
      q.run("INSERT INTO note_revisions(note_id,title,body,created_at) VALUES (?,'x',?,?)", [idle.id, `aged ${index}`, old(30 + index)]);
    }
  });
  await updateNote(edited.id, { body: "next" });
  expect(await listRevisions(edited.id)).toHaveLength(50);
  store.transaction(pruneSQLiteRevisions);
  expect((await listRevisions(idle.id)).map((revision) => revision.title)).toEqual(["x"]);
  expect(store.all<{ body: string }>("SELECT body FROM note_revisions WHERE note_id=?", [idle.id])).toEqual([{ body: "aged 1" }]);
});

test("mention linking is atomic and rejects stale, self, missing, code-only and trashed notes", async () => {
  const target = await createNote({ title: "바질" });
  const source = await createNote({ body: "오늘 바질은 잘 자랐다" });
  expect((await getNoteLinks(target.id)).unlinkedMentions[0]?.id).toBe(source.id);
  await expect(linkMention({ targetId: target.id, sourceId: source.id, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }))
    .rejects.toMatchObject({ code: "conflict", extra: { conflict: "stale" } });
  const linked = await linkMention({ targetId: target.id.toUpperCase(), sourceId: source.id, expectedUpdatedAt: source.updatedAt });
  expect(linked.body).toBe("오늘 [[바질]]은 잘 자랐다");
  expect((await getNoteLinks(target.id)).unlinkedMentions).toEqual([]);
  expect((await listRevisions(source.id))[0]?.reason).toBe("link-mention");
  await expect(linkMention({ targetId: target.id, sourceId: target.id.toUpperCase(), expectedUpdatedAt: target.updatedAt })).rejects.toMatchObject({ code: "validation" });
  const code = await createNote({ body: "`바질` [[바질]]" });
  await expect(linkMention({ targetId: target.id, sourceId: code.id, expectedUpdatedAt: code.updatedAt }))
    .rejects.toMatchObject({ code: "conflict", extra: { conflict: "mention_gone" } });
  await trashNote(target.id);
  await expect(linkMention({ targetId: target.id, sourceId: source.id, expectedUpdatedAt: linked.updatedAt })).rejects.toMatchObject({ code: "conflict" });
});

test("trash retains bytes, enforces 30 days and batches expiry before emptying the rest", async () => {
  const active = await createNote({ title: "active" });
  const expired = await createNote({ title: "expired" });
  const waiting = await createNote({ title: "waiting" });
  const attachment = await saveAttachment(new File(["bytes"], "fixture.txt"), expired.id);
  const trashed = await trashNote(expired.id);
  expect(Date.parse(trashed.purgeAt ?? "") - Date.parse(trashed.deletedAt ?? "")).toBe(30 * 86400_000);
  expect(await readFile(filePath(attachment.storageKey), "utf8")).toBe("bytes");
  await trashNote(waiting.id);
  store.run("UPDATE notes SET purge_at=? WHERE id=?", [old(1), expired.id]);
  expect(await purgeExpired(1)).toBe(1);
  expect(await getNote(expired.id)).toBeNull();
  await expect(readFile(filePath(attachment.storageKey))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await emptyTrash()).toEqual({ purged: 1 });
  expect(await getNote(active.id)).not.toBeNull();
  await expect(purgeNote(active.id)).rejects.toMatchObject({ code: "conflict" });
  await trashNote(active.id);
  const restored = await restoreNote(active.id);
  expect(restored.purgeAt).toBeNull();
  expect(restored.deletedAt).toBeNull();
});

test("attachments preserve metadata, safe names, legacy files and nofollow behavior", async () => {
  const note = await createNote({ title: "owner" });
  const saved = await saveAttachment(new File(["hello"], "../한글\r\n.txt", { type: "text/plain" }), note.id.toUpperCase());
  expect(saved.filename).toBe("한글.txt");
  expect(saved.sizeBytes).toBe(5);
  expect(saved.noteId).toBe(note.id);
  expect(new TextDecoder().decode((await loadAttachment(saved.id.toUpperCase())).bytes)).toBe("hello");
  const legacy = `${randomUUID()}-old\\report.txt`;
  await writeFile(filePath(legacy), "legacy");
  const row = store.get<{ id: string }>("INSERT INTO attachments(filename,mime,size_bytes,storage_key) VALUES ('legacy','text/plain',6,?) RETURNING id", [legacy]);
  if (!row) throw new Error("Missing legacy attachment");
  expect(new TextDecoder().decode((await loadAttachment(row.id)).bytes)).toBe("legacy");
  const outside = path.join(directory, "outside");
  await writeFile(outside, "outside");
  await rm(filePath(saved.storageKey));
  await symlink(outside, filePath(saved.storageKey));
  await expect(loadAttachment(saved.id)).rejects.toMatchObject({ code: "not_found" });
  await trashNote(note.id);
  await purgeNote(note.id);
  expect(await readFile(outside, "utf8")).toBe("outside");
  await expect(readFile(filePath(saved.storageKey))).rejects.toMatchObject({ code: "ENOENT" });
});

test("attachment validation happens before writing and unsafe stored keys cannot escape storage", async () => {
  await expect(saveAttachment(new File([], "empty"))).rejects.toMatchObject({ code: "validation" });
  await expect(saveAttachment(new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "large"))).rejects.toMatchObject({ code: "payload_too_large" });
  await expect(saveAttachment(new File(["x"], "x"), randomUUID())).rejects.toMatchObject({ code: "not_found" });
  await expect(loadAttachment("../outside")).rejects.toMatchObject({ code: "validation" });
  const row = store.get<{ id: string }>("INSERT INTO attachments(filename,mime,size_bytes,storage_key) VALUES ('x','text/plain',1,'../outside') RETURNING id");
  if (!row) throw new Error("Missing unsafe attachment");
  await expect(loadAttachment(row.id)).rejects.toMatchObject({ code: "not_found" });
});

test("purge rehomes shared attachment to active most-recent linker and queues only exclusive bytes", async () => {
  const owner = await createNote({ title: "owner" });
  const shared = await saveAttachment(new File(["shared"], "shared"), owner.id);
  const exclusive = await saveAttachment(new File(["exclusive"], "exclusive"), owner.id);
  const body = `![shared](/api/attachments/${shared.id.toUpperCase()})`;
  const first = await createNote({ title: "first", body });
  const second = await createNote({ title: "second", body });
  const trashed = await createNote({ title: "trashed", body });
  store.run("UPDATE notes SET updated_at=? WHERE id=?", ["2020-01-01T00:00:00.000000Z", first.id]);
  await trashNote(trashed.id);
  await trashNote(owner.id);
  await purgeNote(owner.id);
  expect((await loadAttachment(shared.id)).attachment.noteId).toBe(second.id);
  await expect(readFile(filePath(exclusive.storageKey))).rejects.toMatchObject({ code: "ENOENT" });
  expect(store.all("SELECT storage_key FROM attachment_cleanup")).toEqual([]);
});

test("failed cleanup survives reopen and does not starve later batches", async () => {
  const note = await createNote({ title: "cleanup" });
  await mkdir(path.join(directory, "attachments"));
  const keys = Array.from({ length: 35 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  const blocked = keys[0];
  if (!blocked) throw new Error("Missing blocked key");
  for (const key of keys) {
    if (key === blocked) {
      await mkdir(filePath(key));
      await writeFile(path.join(filePath(key), "blocker"), "keep");
    } else await writeFile(filePath(key), "remove");
    store.run("INSERT INTO attachments(note_id,filename,mime,size_bytes,storage_key) VALUES (?,'x','text/plain',1,?)", [note.id, key]);
  }
  await trashNote(note.id);
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await purgeNote(note.id);
    expect(await getNote(note.id)).toBeNull();
    expect(store.all("SELECT storage_key FROM attachment_cleanup")).toEqual([{ storage_key: blocked }]);
    expect(await readdir(path.join(directory, "attachments"))).toEqual([blocked]);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(blocked);
    await closeSQLiteStore();
    await rm(filePath(blocked), { recursive: true });
    await writeFile(filePath(blocked), "retry");
    await retryAttachmentCleanup();
    store = await sqliteStore();
    expect(store.all("SELECT storage_key FROM attachment_cleanup")).toEqual([]);
    await expect(readFile(filePath(blocked))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { warning.mockRestore(); }
});

test("purge rollback leaves attachment bytes, ownership and cleanup queue intact", async () => {
  const owner = await createNote({ title: "owner" });
  const attachment = await saveAttachment(new File(["keep"], "x"), owner.id);
  await trashNote(owner.id);
  expect(() => store.transaction((q) => {
    expect(purgeSQLiteNote(q, owner.id, "trashed")).toBe(true);
    throw new Error("abort");
  })).toThrow("abort");
  expect((await getNote(owner.id))?.deletedAt).not.toBeNull();
  expect((await loadAttachment(attachment.id)).attachment.noteId).toBe(owner.id);
  expect(store.all("SELECT * FROM attachment_cleanup")).toEqual([]);
});

test("staged upload holds no writer and revalidates ownership after a deterministic purge barrier", async () => {
  const note = await createNote({ title: "race" });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class StagedFile extends File {
    override async arrayBuffer(): Promise<ArrayBuffer> {
      entered.resolve();
      await release.promise;
      return super.arrayBuffer();
    }
  }
  const upload = saveAttachment(new StagedFile(["staged"], "x"), note.id);
  try {
    await entered.promise;
    // A second connection can acquire the writer while the file read is suspended.
    using other = openSQLite({ filename: path.join(directory, "notes.sqlite"), busyTimeoutMs: 0 });
    other.transaction((q) => q.run("UPDATE notes SET pinned=1 WHERE id=?", [note.id]));
    await trashNote(note.id);
    await purgeNote(note.id);
  } finally { release.resolve(); }
  await expect(upload).rejects.toMatchObject({ code: "not_found" });
  expect(await readdir(path.join(directory, "attachments"))).toEqual([]);
  expect(store.all("SELECT id FROM attachments")).toEqual([]);
});

test("competing SQLite writers fail deterministically without partially applying helper writes", async () => {
  using other = openSQLite({ filename: path.join(directory, "notes.sqlite"), busyTimeoutMs: 0 });
  store.transaction((q) => {
    createSQLiteNote(q, { title: "held" });
    expect(() => other.transaction((writer) => createSQLiteNote(writer, { title: "busy" }))).toThrow();
  });
  expect(await findNoteTitles("busy")).toEqual([]);
  expect((await findNoteTitles("held"))).toHaveLength(1);
});

test("maintenance ages revisions and expired trash without requiring PostgreSQL", async () => {
  const note = await createNote({ title: "maintenance" });
  await trashNote(note.id);
  store.run("UPDATE notes SET purge_at=? WHERE id=?", [old(1), note.id]);
  await runNoteMaintenance();
  expect(await getNote(note.id)).toBeNull();
});
