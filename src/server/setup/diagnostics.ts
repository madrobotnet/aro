import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { queryOne } from "@/server/db";
import { readSQLiteNumber } from "@/server/db/sqlite/values";

/** Owner-triggered aggregate diagnostics; no identifiers, paths, text or credentials. */
export async function localDiagnostics() {
  const backend = databaseBackend();
  let counts: { notes: number; inbox: number; attachments: number } | null = null;
  try {
    const sql = `SELECT (SELECT count(*) FROM notes WHERE deleted_at IS NULL) AS notes,
      (SELECT count(*) FROM inbox_items WHERE discarded_at IS NULL AND promoted_note_id IS NULL) AS inbox,
      (SELECT count(*) FROM attachments) AS attachments`;
    if (backend === "sqlite") {
      const result = (await sqliteStore()).get<{ notes: bigint; inbox: bigint; attachments: bigint }>(sql);
      if (result) counts = { notes: readSQLiteNumber(result.notes), inbox: readSQLiteNumber(result.inbox), attachments: readSQLiteNumber(result.attachments) };
    } else {
      const result = await queryOne<{ notes: string; inbox: string; attachments: string }>(sql);
      if (result) counts = { notes: Number(result.notes), inbox: Number(result.inbox), attachments: Number(result.attachments) };
    }
  } catch { /* An unavailable database is itself a diagnostic, not a secret-bearing error payload. */ }
  const manifest: { version: string } = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    application: { version: manifest.version, backend },
    runtime: { platform: process.platform, architecture: process.arch, bun: process.versions.bun ?? null },
    database: { available: counts !== null, counts },
    externalSubmission: false,
  };
}
