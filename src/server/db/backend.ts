import { isAbsolute } from "node:path";
import type { SQLiteStore } from "./sqlite";

/** Explicit opt-in; PostgreSQL remains the existing installation default. */
export function databaseBackend(): "postgres" | "sqlite" {
  const mode = process.env.ARO_DATABASE_MODE ?? "postgres";
  if (mode !== "postgres" && mode !== "sqlite") {
    throw new Error("ARO_DATABASE_MODE must be postgres or sqlite");
  }
  return mode;
}

export function databaseConfigured(): boolean {
  return databaseBackend() === "sqlite"
    ? Boolean(process.env.ARO_SQLITE_PATH && isAbsolute(process.env.ARO_SQLITE_PATH))
    : Boolean(process.env.DATABASE_URL?.trim());
}

type SQLiteRuntime = {
  filename: string | null;
  ready: Promise<SQLiteStore> | null;
};

const runtimeGlobal = globalThis as typeof globalThis & { __aroSQLite?: SQLiteRuntime };
const state = runtimeGlobal.__aroSQLite ??= { filename: null, ready: null };

/** The desktop launcher must create the private parent directory first. */
export async function sqliteStore(): Promise<SQLiteStore> {
  if (databaseBackend() !== "sqlite") throw new Error("SQLite backend is not selected");
  const filename = process.env.ARO_SQLITE_PATH;
  if (!filename || !isAbsolute(filename)) throw new Error("ARO_SQLITE_PATH must be an absolute filename");
  if (state.filename !== null && state.filename !== filename) {
    throw new Error("SQLite database path changed while connected");
  }
  if (!state.ready) {
    state.filename = filename;
    state.ready = import("./sqlite").then(({ openSQLite }) => openSQLite({ filename })).catch((error: unknown) => {
      state.ready = null;
      state.filename = null;
      throw error;
    });
  }
  return state.ready;
}

/** Test/shutdown hook, never called while requests are active. */
export async function closeSQLiteStore(): Promise<void> {
  const store = await state.ready;
  if (store) store.close();
  state.ready = null;
  state.filename = null;
}
