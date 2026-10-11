import { expect, test } from "bun:test";
import {
  readSQLiteBoolean, readSQLiteJson, readSQLiteNumber, readSQLiteStringArray,
  sqliteBoolean, sqliteJson, sqliteStringArray, sqliteTimestamp, sqliteUuid,
} from "./index";
import { seedRelations, SQLiteFixture } from "./test-fixture";

test("normalizes public UUID time array JSON and boolean representations", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const id = "12345678-ABCD-4321-ABCD-1234567890AB";
  // When
  db.run("INSERT INTO notes(id,title,body,tags,aliases,pinned,updated_at) VALUES (?,'한글','body',?,?,?,?)", [
    sqliteUuid(id), sqliteStringArray(["a", "태그"]), sqliteStringArray(["別名"]),
    sqliteBoolean(true), sqliteTimestamp("2026-10-11T12:30:40.123456Z"),
  ]);
  // Then
  const row = db.get<{ id: string; updated_at: string; pinned: bigint; tags: string; aliases: string }>("SELECT * FROM notes");
  if (!row) throw new Error("Missing stored note");
  expect(row.id).toBe(id.toLowerCase());
  expect(row.updated_at).toBe("2026-10-11T12:30:40.123456Z");
  expect(new Date(row.updated_at).toISOString()).toBe("2026-10-11T12:30:40.123Z");
  expect(readSQLiteBoolean(row.pinned)).toBe(true);
  expect(readSQLiteStringArray(row.tags)).toEqual(["a", "태그"]);
  expect(readSQLiteStringArray(row.aliases)).toEqual(["別名"]);
  const value = { version: 2, chatId: null, nested: [true, 0, "한글"] };
  expect(readSQLiteJson(sqliteJson(value))).toEqual(value);
  expect(sqliteTimestamp(new Date("2026-10-11T12:30:40.123Z"))).toBe("2026-10-11T12:30:40.123000Z");
});

test.each([
  ["tags", "{}"], ["tags", '["ok",1]'], ["tags", "not JSON"], ["aliases", "[null]"],
  ["pinned", 2], ["id", "invalid"], ["id", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"],
  ["daily_date", "2026-02-30"], ["daily_date", "2026-1-1"],
  ["updated_at", "2026-02-30T00:00:00.000000Z"], ["updated_at", "2026-10-11T24:00:00.000000Z"],
  ["updated_at", "2026-10-11T00:00:00.000Z"], ["updated_at", "2026-10-11T00:00:00.000000+00:00"],
] as const)("rejects noncanonical note %s = %s", (column, value) => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { first } = seedRelations(db);
  // When / Then
  expect(() => db.run(`UPDATE notes SET ${column}=? WHERE id=?`, [value, first])).toThrow();
});

test("enforces JSON and enum constraints beyond notes", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { first, owner, thread } = seedRelations(db);
  // When / Then
  expect(() => db.run("INSERT INTO note_revisions(note_id,title,body,tags) VALUES (?,'t','b','[false]')", [first])).toThrow();
  expect(() => db.run("UPDATE inbox_items SET suggestions='broken'")).toThrow();
  expect(() => db.run("INSERT INTO chat_messages(thread_id,role,content) VALUES (?,'tool','body')", [thread])).toThrow();
  expect(() => db.run("INSERT INTO chat_messages(thread_id,role,content,citations) VALUES (?,'assistant','body','broken')", [thread])).toThrow();
  expect(() => db.run("INSERT INTO ai_connections(owner_id,purpose,name,connection) VALUES (?,'other','n','{}')", [owner])).toThrow();
  expect(() => db.run("INSERT INTO ai_connections(owner_id,purpose,name,connection) VALUES (?,'chat','n','broken')", [owner])).toThrow();
  expect(() => db.run("INSERT INTO attachments(filename,mime,size_bytes,storage_key) VALUES ('f','m',-1,'k')")).toThrow();
  expect(() => db.run("INSERT INTO attachments(filename,mime,size_bytes,storage_key) VALUES ('f','m',?,'k')", [9007199254740992n])).toThrow();
});

test("persists constrained embedding caches without pretending to implement vector retrieval", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { first } = seedRelations(db);
  const vector = Array.from({ length: 768 }, (_, i) => i / 1000);
  db.run("INSERT INTO note_passages VALUES (?,'model','hash',0,'heading',1,5,'body',?)", [first, JSON.stringify(vector)]);
  // When / Then
  expect(JSON.parse(db.get<{ embedding: string }>("SELECT embedding FROM note_passages")?.embedding ?? "null")).toEqual(vector);
  expect(() => db.run("INSERT INTO note_passages VALUES (?,'model','hash',0,'heading',1,5,'body',?)",
    [first, JSON.stringify(vector)])).toThrow();
  for (const embedding of ["[]", JSON.stringify(Array(127).fill(0)), JSON.stringify(Array(128).fill("x")),
    JSON.stringify(Array(128).fill(null)), JSON.stringify(Array(128).fill(1e100))]) {
    expect(() => db.run("UPDATE notes SET search_embedding=? WHERE id=?", [embedding, first])).toThrow();
  }
  db.run("UPDATE notes SET search_embedding=? WHERE id=?", [JSON.stringify(Array(128).fill(0.5)), first]);
  expect(() => db.run("UPDATE note_passages SET embedding='[1]'")).toThrow();
});

test("rejects invalid conversion inputs rather than silently changing public values", () => {
  // Given / When / Then
  expect(() => sqliteUuid("not-an-id")).toThrow();
  for (const value of ["2026-02-30T00:00:00Z", "2026-10-11T00:00:00+09:00", "2026-10-11T00:00:00.1234567Z"]) {
    expect(() => sqliteTimestamp(value)).toThrow();
  }
  expect(() => readSQLiteBoolean(2n)).toThrow();
  expect(() => readSQLiteNumber(9007199254740992n)).toThrow();
  expect(readSQLiteNumber(9007199254740991n)).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => sqliteJson({ bad: NaN })).toThrow();
  expect(() => readSQLiteStringArray('["a",1]')).toThrow();
  expect(() => readSQLiteJson("{")).toThrow();
});
