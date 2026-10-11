import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { SQLiteFoundationError } from "./errors";
import { SQLITE_MIGRATIONS, type SQLiteMigration } from "./migrations";

const APPLICATION_ID = 0x41524f31; // ARO1, not PostgreSQL's migration namespace.

export function assertSQLiteIdentity(db: Database): void {
  const identity = db.query<{ application_id: number | bigint }, []>("PRAGMA application_id").get();
  const id = Number(identity?.application_id);
  if (id === APPLICATION_ID) return;
  const objects = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
  ).get();
  if (id !== 0 || objects) {
    throw new SQLiteFoundationError("foreign_database", "Expected an empty database or an Aro SQLite database");
  }
}

/**
 * Internal migration entry point, also used by file-backed upgrade fixtures.
 * All pending entries commit together, after acquiring the single writer lock.
 */
export function migrateSQLite(db: Database, migrations: readonly SQLiteMigration[] = SQLITE_MIGRATIONS): void {
  const entries = migrations.map((migration, index) => {
    if (!new RegExp(`^${String(index + 1).padStart(4, "0")}_[a-z0-9_]+$`).test(migration.id)
      || migration.statements.length === 0) {
      throw new SQLiteFoundationError("migration_history", "Migrations must be a nonempty contiguous ordered history");
    }
    return {
      ...migration,
      checksum: createHash("sha256").update(JSON.stringify([migration.id, migration.statements])).digest("hex"),
    };
  });
  if (entries.length === 0 || db.inTransaction
    || Number(db.query<{ foreign_keys: number | bigint }, []>("PRAGMA foreign_keys").get()?.foreign_keys) !== 1) {
    throw new SQLiteFoundationError("configuration", "Migration requires foreign keys and an idle connection");
  }
  db.transaction(() => {
    assertSQLiteIdentity(db);
    const owned = Number(db.query<{ application_id: number | bigint }, []>("PRAGMA application_id").get()?.application_id);
    if (owned === APPLICATION_ID) {
      const history = db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name='aro_schema_migrations'",
      ).get();
      if (!history) throw new SQLiteFoundationError("migration_history", "Aro migration history is missing");
    } else {
      db.run(`PRAGMA application_id = ${APPLICATION_ID}`);
      db.run(`CREATE TABLE aro_schema_migrations (
        position INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z')
      ) STRICT`);
    }
    const applied = db.query<{ position: number | bigint; id: string; checksum: string }, []>(
      "SELECT position, id, checksum FROM aro_schema_migrations ORDER BY position",
    ).all();
    for (const [index, row] of applied.entries()) {
      const expected = entries[index];
      if (!expected || Number(row.position) !== index + 1 || row.id !== expected.id || row.checksum !== expected.checksum) {
        throw new SQLiteFoundationError("migration_history", "Applied SQLite history differs from this application");
      }
    }
    for (const [index, migration] of entries.entries()) {
      if (index < applied.length) continue;
      for (const sql of migration.statements) {
        // These are code-owned DDL/DML, not a SQL translator or an untrusted script API.
        if (!/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql)) {
          throw new SQLiteFoundationError("migration_statement", "Migration statements cannot manage transactions or pragmas");
        }
        using statement = db.prepare(sql);
        // Native SQLite parses triggers correctly; do not split SQL on semicolons.
        if (statement.toString().trim() !== sql.trim()) {
          throw new SQLiteFoundationError("migration_statement", "Each migration entry must contain exactly one SQL statement");
        }
        statement.run();
      }
      db.run("INSERT INTO aro_schema_migrations(position,id,checksum) VALUES (?,?,?)",
        [index + 1, migration.id, migration.checksum]);
    }
    if (db.query("PRAGMA foreign_key_check").get()) {
      throw new SQLiteFoundationError("migration_history", "Migration left foreign key violations");
    }
  }).immediate();
}
