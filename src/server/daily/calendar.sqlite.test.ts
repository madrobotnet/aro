import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { listDailyMonth } from "./calendar";

test("SQLite calendar includes archived days, excludes trash and honors leap-month bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-calendar-"));
  const before = { ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE, ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH };
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "calendar.sqlite");
  try {
    const store = await sqliteStore();
    for (const [date, status, deleted] of [
      ["2028-02-01", "draft", null], ["2028-02-29", "archived", null],
      ["2028-03-01", "draft", null], ["2028-02-12", "draft", "2028-02-13T00:00:00.000000Z"],
    ]) {
      store.run("INSERT INTO notes(title,body,daily_date,status,deleted_at) VALUES (?,?,?,?,?)",
        ["Daily", "", date ?? null, status ?? null, deleted ?? null]);
    }
    expect((await listDailyMonth("2028-02")).days.map(day => day.date)).toEqual(["2028-02-01", "2028-02-29"]);
    expect((await listDailyMonth("2028-01")).days).toEqual([]);
  } finally {
    await closeSQLiteStore();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
