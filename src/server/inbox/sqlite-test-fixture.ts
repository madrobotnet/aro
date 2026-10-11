import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { SQLiteFixture } from "@/server/db/sqlite/test-fixture";
import { setJevForTests } from "@/server/jev/client";

/** A private file, including WAL sidecars, and restored process configuration per test. */
export async function inboxFixture() {
  const fixture = new SQLiteFixture();
  const previous = { mode: process.env.ARO_DATABASE_MODE, path: process.env.ARO_SQLITE_PATH };
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = fixture.filename;
  setJevForTests(null);
  try {
    const store = await sqliteStore();
    return { fixture, store, async close() {
      try { await closeSQLiteStore(); } finally {
        setJevForTests(undefined);
        if (previous.mode === undefined) delete process.env.ARO_DATABASE_MODE;
        else process.env.ARO_DATABASE_MODE = previous.mode;
        if (previous.path === undefined) delete process.env.ARO_SQLITE_PATH;
        else process.env.ARO_SQLITE_PATH = previous.path;
        fixture[Symbol.dispose]();
      }
    } };
  } catch (error) {
    fixture[Symbol.dispose]();
    throw error;
  }
}

export function barrier() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return { entered: entered.promise, enter: () => entered.resolve(),
    released: released.promise, release: () => released.resolve() };
}
