import { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import { isAsyncFunction } from "node:util/types";
import { SQLiteFoundationError } from "./errors";
import { createExecutor, type SQLiteExecutor } from "./executor";
import { assertSQLiteIdentity, migrateSQLite } from "./migrate";

export type { SQLiteExecutor, SQLiteRow, SQLiteValue } from "./executor";
export { SQLiteFoundationError } from "./errors";
export * from "./values";

export interface SQLiteStore extends SQLiteExecutor, Disposable {
  transaction<T>(fn: (executor: SQLiteExecutor) => T & (T extends PromiseLike<unknown> ? never : unknown)): T;
  close(): void;
}

export type SQLiteOptions = {
  /** Absolute file path in an existing private directory, or explicitly :memory:. */
  readonly filename: string;
  /** Synchronous lock wait bound. Zero fails immediately; no automatic retries. */
  readonly busyTimeoutMs?: number;
};

/** No globals, environment inspection, connection pool, or production mode selection. */
export function openSQLite(options: SQLiteOptions): SQLiteStore {
  const timeout = options.busyTimeoutMs ?? 1000;
  if ((options.filename !== ":memory:" && !isAbsolute(options.filename))
    || !Number.isInteger(timeout) || timeout < 0 || timeout > 60_000) {
    throw new SQLiteFoundationError("configuration", "Expected an absolute filename and busy timeout between 0 and 60000 ms");
  }
  const db = new Database(options.filename, { create: true, strict: true, safeIntegers: true });
  try {
    assertSQLiteIdentity(db);
    db.run(`PRAGMA busy_timeout = ${timeout}`);
    db.run("PRAGMA foreign_keys = ON");
    const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()?.journal_mode;
    if (journal !== (options.filename === ":memory:" ? "memory" : "wal")) {
      throw new SQLiteFoundationError("configuration", "SQLite could not enable the required journal mode");
    }
    db.run("PRAGMA synchronous = FULL");
    db.run("PRAGMA wal_autocheckpoint = 1000");
    migrateSQLite(db);
  } catch (error) {
    db.close(true);
    throw error;
  }

  let closed = false;
  let inCallback = false;
  const assertIdle = (): void => {
    if (closed || inCallback) {
      throw new SQLiteFoundationError("transaction_scope", "Use an open store outside transactions, or the callback executor inside");
    }
  };
  const executor = createExecutor(db, assertIdle);
  const close = (): void => {
    if (closed) return;
    assertIdle();
    db.close(true);
    closed = true;
  };
  return {
    ...executor,
    transaction<T>(fn: (executor: SQLiteExecutor) => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
      assertIdle();
      if (isAsyncFunction(fn)) {
        throw new SQLiteFoundationError("async_transaction", "SQLite transaction callbacks must be synchronous");
      }
      return db.transaction(() => {
        inCallback = true;
        let active = true;
        const scoped = createExecutor(db, () => {
          if (!active) throw new SQLiteFoundationError("transaction_scope", "Transaction executor has expired");
        });
        try {
          const value = fn(scoped);
          if (value !== null && (typeof value === "object" || typeof value === "function")
            && "then" in value && typeof value.then === "function") {
            throw new SQLiteFoundationError("async_transaction", "SQLite transaction callbacks must be synchronous");
          }
          return value;
        } finally {
          active = false;
          inCallback = false;
        }
      }).immediate();
    },
    close,
    [Symbol.dispose]: close,
  };
}
