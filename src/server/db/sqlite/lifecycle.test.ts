import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { openSQLite, SQLiteFoundationError, type SQLiteExecutor } from "./index";
import { note, SQLiteFixture } from "./test-fixture";

test("reopens committed Unicode data with stable IDs and microsecond ordering", () => {
  // Given
  using fixture = new SQLiteFixture();
  const first = fixture.open();
  const id = note(first, "한글 café");
  first.run("UPDATE notes SET updated_at=?, tags=?, aliases=? WHERE id=?",
    ["2026-10-11T12:13:14.123456Z", '["개발","café"]', '["별칭"]', id]);
  const earlier = note(first, "Earlier");
  first.run("UPDATE notes SET updated_at=? WHERE id=?", ["2026-10-11T12:13:14.123455Z", earlier]);
  first.close();
  // When
  const reopened = fixture.open();
  // Then
  expect(reopened.get("SELECT id,title,updated_at,tags,aliases FROM notes WHERE id=?", [id])).toEqual({
    id, title: "한글 café", updated_at: "2026-10-11T12:13:14.123456Z", tags: '["개발","café"]', aliases: '["별칭"]',
  });
  expect(reopened.all("SELECT id FROM notes WHERE updated_at > ? ORDER BY updated_at,id",
    ["2026-10-11T12:13:14.123455Z"])).toEqual([{ id }]);
});

test("sets deliberate connection pragmas on every open", () => {
  // Given
  using fixture = new SQLiteFixture();
  // When
  const db = fixture.open(37);
  // Then
  expect(db.get("SELECT * FROM pragma_foreign_keys")).toEqual({ foreign_keys: 1n });
  expect(db.get("SELECT * FROM pragma_journal_mode")).toEqual({ journal_mode: "wal" });
  expect(db.get("SELECT * FROM pragma_synchronous")).toEqual({ synchronous: 2n });
  expect(db.get("SELECT * FROM pragma_busy_timeout")).toEqual({ timeout: 37n });
  note(db, "WAL write");
  expect(existsSync(`${fixture.filename}-wal`)).toBe(true);
});

test("rolls back note revision and link writes as one unit", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const original = note(db, "Before");
  // When
  expect(() => db.transaction((tx) => {
    tx.run("INSERT INTO note_revisions(note_id,title,body) SELECT id,title,body FROM notes WHERE id=?", [original]);
    tx.run("UPDATE notes SET title='After' WHERE id=?", [original]);
    const other = note(tx, "Other");
    tx.run("INSERT INTO links(from_note_id,to_note_id) VALUES (?,?)", [original, other]);
    throw new Error("cancel local edit");
  })).toThrow("cancel local edit");
  // Then
  expect(db.all("SELECT title FROM notes")).toEqual([{ title: "Before" }]);
  expect(db.all("SELECT * FROM note_revisions")).toEqual([]);
  expect(db.all("SELECT * FROM links")).toEqual([]);
});

test("commits a composed transaction and expires its executor", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  let escaped: SQLiteExecutor | undefined;
  // When
  const id = db.transaction((tx) => { escaped = tx; return note(tx, "Committed"); });
  // Then
  expect(db.get("SELECT title FROM notes WHERE id=?", [id])).toEqual({ title: "Committed" });
  expect(() => escaped?.run("DELETE FROM notes")).toThrow(SQLiteFoundationError);
});

test("rejects async callbacks before their first write", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  // When: Reflect simulates an untyped caller without weakening the TypeScript API.
  expect(() => Reflect.apply(db.transaction, db, [async (tx: SQLiteExecutor) => note(tx)])).toThrow(SQLiteFoundationError);
  // Then
  expect(db.all("SELECT * FROM notes")).toEqual([]);
});

test("rejects returned promises and rolls back synchronous writes", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  // When
  expect(() => Reflect.apply(db.transaction, db, [(tx: SQLiteExecutor) => {
    note(tx);
    return Promise.resolve("invalid transaction result");
  }])).toThrow(SQLiteFoundationError);
  // Then
  expect(db.all("SELECT * FROM notes")).toEqual([]);
});

test("rejects root access nested transactions and close during callback", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  // When
  db.transaction((tx) => {
    expect(() => db.get("SELECT 1")).toThrow(SQLiteFoundationError);
    expect(() => db.transaction(() => 1)).toThrow(SQLiteFoundationError);
    expect(() => db.close()).toThrow(SQLiteFoundationError);
    note(tx);
  });
  // Then
  expect(db.get("SELECT count(*) AS total FROM notes")).toEqual({ total: 1n });
});

test("keeps WAL readers on their snapshot while another connection commits", () => {
  // Given
  using fixture = new SQLiteFixture();
  const writer = fixture.open();
  note(writer, "Before");
  const reader = fixture.raw();
  reader.run("BEGIN");
  reader.query("SELECT title FROM notes").all();
  // When
  writer.transaction((tx) => tx.run("UPDATE notes SET title='After'"));
  // Then
  expect(reader.query("SELECT title FROM notes").all()).toEqual([{ title: "Before" }]);
  reader.run("COMMIT");
  expect(reader.query("SELECT title FROM notes").all()).toEqual([{ title: "After" }]);
});

test("fails a competing writer immediately and permits it after release", () => {
  // Given
  using fixture = new SQLiteFixture();
  const first = fixture.open();
  const second = fixture.open();
  // When
  first.transaction((tx) => {
    note(tx, "Held");
    expect(() => note(second, "Blocked")).toThrow("database is locked");
    expect(second.get("SELECT count(*) AS total FROM notes")).toEqual({ total: 0n });
  });
  // Then
  note(second, "Released");
  expect(second.get("SELECT count(*) AS total FROM notes")).toEqual({ total: 2n });
});

test("binds exact values and never reuses missing parameters", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  expect(db.get("SELECT ? AS value", ["bound"])).toEqual({ value: "bound" });
  // When / Then
  expect(() => db.get("SELECT ? AS value")).toThrow();
  expect(db.get("SELECT ? AS value", [9223372036854775807n])).toEqual({ value: 9223372036854775807n });
  expect(() => db.get("SELECT ?", [Number.MAX_SAFE_INTEGER + 1])).toThrow(SQLiteFoundationError);
  expect(() => db.get("SELECT ?", [NaN])).toThrow(SQLiteFoundationError);
  expect(db.get("SELECT ? AS value", ["'; DELETE FROM notes; --"])).toEqual({ value: "'; DELETE FROM notes; --" });
  expect(db.get("SELECT ';''quoted' AS value; -- trailing comment")).toEqual({ value: ";'quoted" });
  expect(db.get('SELECT ? AS "semi;colon" /* ignored ; */;', ["safe"])).toEqual({ "semi;colon": "safe" });
});

test.each([
  "BEGIN", "COMMIT", "PRAGMA foreign_keys=OFF", "CREATE TABLE forbidden(x)", "SELECT 1; DELETE FROM notes",
  "SELECT ?; DELETE FROM notes", "SELECT 1; /* gap */ DELETE FROM notes", "SELECT 1\0; DELETE FROM notes",
])(
  "rejects unmanaged executor SQL: %s", (sql) => {
    // Given
    using fixture = new SQLiteFixture();
    const db = fixture.open();
    note(db);
    // When / Then
    expect(() => db.run(sql)).toThrow(SQLiteFoundationError);
    expect(db.get("SELECT count(*) AS total FROM notes")).toEqual({ total: 1n });
  },
);

test("closes idempotently and removes the entire test directory", () => {
  // Given
  let directory = "";
  {
    using fixture = new SQLiteFixture();
    directory = fixture.directory;
    const db = fixture.open();
    note(db);
    // When
    db.close();
    db.close();
    // Then
    expect(() => db.get("SELECT 1")).toThrow(SQLiteFoundationError);
  }
  expect(existsSync(directory)).toBe(false);
});

test("rejects implicit paths and invalid timeout options", () => {
  // Given / When / Then
  for (const filename of ["", "relative.sqlite", "file:shared?mode=memory"]) {
    expect(() => openSQLite({ filename })).toThrow(SQLiteFoundationError);
  }
  for (const busyTimeoutMs of [-1, 0.5, 60_001, NaN]) {
    expect(() => openSQLite({ filename: ":memory:", busyTimeoutMs })).toThrow(SQLiteFoundationError);
  }
});
