import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSQLite, type SQLiteExecutor, type SQLiteStore } from "./index";

/** Every test owns its directory, connections and WAL sidecars. No shared database. */
export class SQLiteFixture implements Disposable {
  readonly directory = mkdtempSync(join(tmpdir(), "aro-sqlite-"));
  readonly filename = join(this.directory, "aro.sqlite");
  private readonly closers: (() => void)[] = [];

  open(busyTimeoutMs = 0): SQLiteStore {
    const store = openSQLite({ filename: this.filename, busyTimeoutMs });
    this.closers.push(() => store.close());
    return store;
  }

  raw(): Database {
    const db = new Database(this.filename, { strict: true, safeIntegers: true });
    this.closers.push(() => db.close(true));
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 0");
    return db;
  }

  [Symbol.dispose](): void {
    try {
      for (const close of this.closers.reverse()) close();
    } finally {
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}

export function note(db: SQLiteExecutor, title = "Note"): string {
  const row = db.get<{ id: string }>("INSERT INTO notes(title,body) VALUES (?,?) RETURNING id", [title, "Body"]);
  if (!row) throw new Error("Fixture insert did not return a note");
  return row.id;
}

export function seedRelations(db: SQLiteExecutor) {
  const first = note(db, "First");
  const second = note(db, "Second");
  const owner = db.get<{ id: string }>("INSERT INTO users(password_hash) VALUES ('hash') RETURNING id")?.id;
  const inbox = db.get<{ id: string }>("INSERT INTO inbox_items(title,source) VALUES ('Capture','web') RETURNING id")?.id;
  const thread = db.get<{ id: string }>("INSERT INTO chat_threads DEFAULT VALUES RETURNING id")?.id;
  if (!owner || !inbox || !thread) throw new Error("Fixture insert did not return identities");
  return { first, second, owner, inbox, thread };
}
