import type { Changes, Database, Statement } from "bun:sqlite";
import { SQLiteFoundationError } from "./errors";

export type SQLiteValue = string | number | bigint | Uint8Array | null;
export type SQLiteRow = Readonly<Record<string, SQLiteValue>>;

/** Trusted, SQLite-native repository SQL only; values always use positional bindings. */
export interface SQLiteExecutor {
  all<T extends object = SQLiteRow>(sql: string, params?: readonly SQLiteValue[]): T[];
  get<T extends object = SQLiteRow>(sql: string, params?: readonly SQLiteValue[]): T | null;
  run(sql: string, params?: readonly SQLiteValue[]): Changes;
}

/** Inspect only statement boundaries; SQLite still parses the SQL itself. */
function assertSingleStatement(sql: string): void {
  let ended = false;
  if (sql.includes("\0")) throw new SQLiteFoundationError("executor_statement", "SQL cannot contain NUL");
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === undefined || /\s/.test(char)) continue;
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 1;
      continue;
    }
    if (ended) throw new SQLiteFoundationError("executor_statement", "Executor accepts exactly one SQL statement");
    if (char === ";") {
      ended = true;
    } else if (char === "'" || char === '"' || char === "`" || char === "[") {
      const delimiter = char === "[" ? "]" : char;
      for (index += 1; index < sql.length; index += 1) {
        if (sql[index] !== delimiter) continue;
        if (delimiter !== "]" && sql[index + 1] === delimiter) index += 1;
        else break;
      }
    }
  }
}

export function createExecutor(db: Database, assertActive: () => void): SQLiteExecutor {
  function prepare<T>(sql: string, params: readonly SQLiteValue[]): Statement<T, SQLiteValue[]> {
    assertActive();
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|EXPLAIN)\b/i.test(sql)) {
      throw new SQLiteFoundationError("executor_statement", "Executor accepts repository DML, not lifecycle or schema commands");
    }
    assertSingleStatement(sql);
    for (const value of params) {
      if (typeof value === "number" && (!Number.isFinite(value)
        || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
        throw new SQLiteFoundationError("representation", "Bind finite numbers or bigint for exact large integers");
      }
    }
    const statement = db.prepare<T, SQLiteValue[]>(sql);
    if (statement.paramsCount !== params.length) {
      statement.finalize();
      throw new SQLiteFoundationError("executor_statement", "Bind every positional parameter exactly once");
    }
    return statement;
  }
  return {
    all<T extends object>(sql: string, params: readonly SQLiteValue[] = []): T[] {
      using statement = prepare<T>(sql, params);
      return statement.all(...params);
    },
    get<T extends object>(sql: string, params: readonly SQLiteValue[] = []): T | null {
      using statement = prepare<T>(sql, params);
      return statement.get(...params);
    },
    run(sql, params = []) {
      using statement = prepare(sql, params);
      return statement.run(...params);
    },
  };
}
