import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSQLiteStore, databaseBackend, sqliteStore } from "./backend";

const originalMode = process.env.ARO_DATABASE_MODE;
const originalPath = process.env.ARO_SQLITE_PATH;
afterEach(async () => {
  await closeSQLiteStore();
  if (originalMode === undefined) delete process.env.ARO_DATABASE_MODE;
  else process.env.ARO_DATABASE_MODE = originalMode;
  if (originalPath === undefined) delete process.env.ARO_SQLITE_PATH;
  else process.env.ARO_SQLITE_PATH = originalPath;
});

test("defaults to PostgreSQL and rejects unknown backend names", () => {
  delete process.env.ARO_DATABASE_MODE;
  expect(databaseBackend()).toBe("postgres");
  process.env.ARO_DATABASE_MODE = "typo";
  expect(() => databaseBackend()).toThrow();
});

test("shares one selected file and refuses path changes until close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-backend-"));
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "notes.sqlite");
  try {
    const [first, second] = await Promise.all([sqliteStore(), sqliteStore()]);
    expect(first).toBe(second);
    first.run("INSERT INTO notes(title,body) VALUES (?,?)", ["Durable", "Body"]);
    process.env.ARO_SQLITE_PATH = join(directory, "other.sqlite");
    await expect(sqliteStore()).rejects.toThrow();
    await closeSQLiteStore();
    process.env.ARO_SQLITE_PATH = join(directory, "notes.sqlite");
    expect((await sqliteStore()).get("SELECT title FROM notes")).toEqual({ title: "Durable" });
  } finally {
    await closeSQLiteStore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires explicit SQLite mode and an absolute database filename", async () => {
  process.env.ARO_DATABASE_MODE = "postgres";
  await expect(sqliteStore()).rejects.toThrow();
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = "relative.sqlite";
  await expect(sqliteStore()).rejects.toThrow();
});
