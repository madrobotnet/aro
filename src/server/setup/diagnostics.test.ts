import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { localDiagnostics } from "./diagnostics";

test("local diagnostic payload contains aggregates but no note values or private paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-diagnostics-"));
  const before = { ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE, ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH };
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "private.sqlite");
  try {
    const store = await sqliteStore();
    store.run("INSERT INTO notes(title,body) VALUES (?,?)", ["private-diagnostic-title", "private-diagnostic-secret"]);
    const report = await localDiagnostics();
    expect(report.schemaVersion).toBe(1);
    expect(report.database).toEqual({ available: true, counts: { notes: 1, inbox: 0, attachments: 0 } });
    expect(report.externalSubmission).toBe(false);
    expect(Object.keys(report).sort()).toEqual(["application", "database", "externalSubmission", "generatedAt", "runtime", "schemaVersion"]);
    const payload = JSON.stringify(report);
    expect(payload).not.toContain(directory);
    expect(payload).not.toContain("private-diagnostic");
  } finally {
    await closeSQLiteStore();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
