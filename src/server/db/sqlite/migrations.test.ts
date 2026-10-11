import { expect, test } from "bun:test";
import { openSQLite, SQLiteFoundationError } from "./index";
import { migrateSQLite } from "./migrate";
import { SQLITE_MIGRATIONS, type SQLiteMigration } from "./migrations";
import { note, SQLiteFixture } from "./test-fixture";

const nextMigrationPrefix = String(SQLITE_MIGRATIONS.length + 1).padStart(4, "0");

test("records each migration once across reopen", () => {
  // Given
  using fixture = new SQLiteFixture();
  const initial = fixture.open();
  const history = initial.all("SELECT * FROM aro_schema_migrations ORDER BY position");
  initial.close();
  // When
  const reopened = fixture.open();
  // Then
  expect(history).toHaveLength(SQLITE_MIGRATIONS.length);
  expect(reopened.all("SELECT * FROM aro_schema_migrations ORDER BY position")).toEqual(history);
});

test("upgrades an earlier SQLite version without losing content", () => {
  // Given
  using fixture = new SQLiteFixture();
  const raw = fixture.raw();
  migrateSQLite(raw, SQLITE_MIGRATIONS.slice(0, 2));
  raw.run("INSERT INTO notes(title,body,deleted_at) VALUES ('Saved','body','2026-01-01T00:00:00.000001Z')");
  raw.run("INSERT INTO inbox_items(title,source) VALUES ('Capture','api')");
  raw.close(true);
  // When
  const upgraded = fixture.open();
  // Then
  const row = upgraded.get<{ title: string; body: string; deleted_at: string; purge_at: string }>("SELECT * FROM notes");
  expect(row).toMatchObject({ title: "Saved", body: "body", deleted_at: "2026-01-01T00:00:00.000001Z" });
  expect(row?.purge_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  expect(upgraded.get("SELECT snoozed_until FROM inbox_items")).toEqual({ snoozed_until: null });
  expect(upgraded.get("SELECT count(*) AS total FROM aro_schema_migrations")).toEqual({ total: BigInt(SQLITE_MIGRATIONS.length) });
});

test("rolls back an entire failed initial migration batch including ownership", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.raw();
  const broken: SQLiteMigration = { id: `${nextMigrationPrefix}_broken`, statements: ["CREATE TABLE marker(x TEXT)", "CREATE TABLE invalid ("] };
  // When
  expect(() => migrateSQLite(db, [...SQLITE_MIGRATIONS, broken])).toThrow("incomplete input");
  // Then
  expect(db.query("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([]);
  expect(db.query("PRAGMA application_id").get()).toEqual({ application_id: 0n });
  migrateSQLite(db);
  expect(db.query("SELECT count(*) AS total FROM aro_schema_migrations").get()).toEqual({ total: BigInt(SQLITE_MIGRATIONS.length) });
});

test("rolls back syntax errors in an upgrade while preserving earlier data", () => {
  // Given
  using fixture = new SQLiteFixture();
  const store = fixture.open();
  const id = note(store, "Preserved");
  const raw = fixture.raw();
  // When
  expect(() => migrateSQLite(raw, [...SQLITE_MIGRATIONS, {
    id: `${nextMigrationPrefix}_broken`, statements: ["UPDATE notes SET title='Lost'", "CREATE TABLE invalid ("],
  }])).toThrow("incomplete input");
  // Then
  expect(store.get("SELECT title FROM notes WHERE id=?", [id])).toEqual({ title: "Preserved" });
  expect(store.get("SELECT count(*) AS total FROM aro_schema_migrations")).toEqual({ total: BigInt(SQLITE_MIGRATIONS.length) });
});

test.each([
  "COMMIT",
  "PRAGMA foreign_keys=OFF",
  "CREATE TABLE marker(x); COMMIT;",
  "CREATE TABLE marker(x); INSERT INTO marker VALUES (1)",
])("rejects migration transaction escapes: %s", (sql) => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.raw();
  // When
  expect(() => migrateSQLite(db, [...SQLITE_MIGRATIONS, { id: `${nextMigrationPrefix}_escape`, statements: [sql] }]))
    .toThrow(expect.objectContaining({ code: "migration_statement" }));
  // Then
  expect(db.query("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([]);
});

test("rejects modified applied migrations and downgrades", () => {
  // Given
  using fixture = new SQLiteFixture();
  fixture.open();
  const db = fixture.raw();
  const modified = SQLITE_MIGRATIONS.map((migration, index) =>
    index === 0 ? { ...migration, statements: [...migration.statements, "CREATE TABLE drift(x)"] } : migration);
  // When / Then
  expect(() => migrateSQLite(db, modified)).toThrow(SQLiteFoundationError);
  expect(() => migrateSQLite(db, SQLITE_MIGRATIONS.slice(0, 3))).toThrow(SQLiteFoundationError);
  expect(db.query("SELECT count(*) AS total FROM aro_schema_migrations").get()).toEqual({ total: BigInt(SQLITE_MIGRATIONS.length) });
});

test.each([
  "DELETE FROM aro_schema_migrations WHERE position=2",
  "UPDATE aro_schema_migrations SET checksum='changed' WHERE position=1",
  "UPDATE aro_schema_migrations SET id='0001_changed' WHERE position=1",
  "DROP TABLE aro_schema_migrations",
])("refuses damaged migration history: %s", (sql) => {
  // Given
  using fixture = new SQLiteFixture();
  fixture.open().close();
  const raw = fixture.raw();
  raw.run(sql);
  raw.close(true);
  // When / Then
  expect(() => fixture.open()).toThrow(SQLiteFoundationError);
});

test("rejects missing or duplicated migration positions before applying SQL", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.raw();
  // When / Then
  expect(() => migrateSQLite(db, [{ id: "0002_gap", statements: ["CREATE TABLE x(y)"] }])).toThrow(SQLiteFoundationError);
  expect(() => migrateSQLite(db, [...SQLITE_MIGRATIONS, ...SQLITE_MIGRATIONS])).toThrow(SQLiteFoundationError);
  expect(() => migrateSQLite(db, [])).toThrow(SQLiteFoundationError);
  expect(db.query("SELECT name FROM sqlite_schema").all()).toEqual([]);
});

test("rejects unrelated SQLite files without changing their journal or data", () => {
  // Given
  using fixture = new SQLiteFixture();
  const raw = fixture.raw();
  raw.run("CREATE TABLE private_data(value TEXT)");
  raw.run("INSERT INTO private_data VALUES ('untouched')");
  // When / Then
  expect(() => openSQLite({ filename: fixture.filename })).toThrow(SQLiteFoundationError);
  expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  expect(raw.query("SELECT * FROM private_data").all()).toEqual([{ value: "untouched" }]);
});

test("requires foreign key enforcement for migration entry point", () => {
  // Given
  using fixture = new SQLiteFixture();
  const raw = fixture.raw();
  raw.run("PRAGMA foreign_keys=OFF");
  // When / Then
  expect(() => migrateSQLite(raw)).toThrow(SQLiteFoundationError);
  expect(raw.query("SELECT name FROM sqlite_schema").all()).toEqual([]);
});
