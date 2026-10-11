import { rm } from "node:fs/promises";
import { query } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { storagePath } from "./attachment-storage";

/** Failed removals keep their durable key for the next startup or purge. */
export async function retryAttachmentCleanup(): Promise<void> {
  let cursor = "";
  let failures = 0;
  let code = "unknown";
  const recordFailure = (error: unknown): void => {
    failures += 1;
    code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code : "unknown";
  };

  // This is the best-effort task boundary, never the committed note operation.
  try {
    while (true) {
      const rows = databaseBackend() === "sqlite"
        ? (await sqliteStore()).all<{ storage_key: string }>(
          "SELECT storage_key FROM attachment_cleanup WHERE storage_key>? ORDER BY storage_key LIMIT 32", [cursor],
        )
        : await query<{ storage_key: string }>(
        `SELECT storage_key FROM attachment_cleanup
         WHERE storage_key > $1 ORDER BY storage_key LIMIT 32`,
        [cursor],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        // Advance even after failure so one bad file cannot starve later keys.
        cursor = row.storage_key;
        try {
          await rm(storagePath(row.storage_key), { force: true });
          if (databaseBackend() === "sqlite") {
            (await sqliteStore()).run("DELETE FROM attachment_cleanup WHERE storage_key=?", [row.storage_key]);
          } else await query("DELETE FROM attachment_cleanup WHERE storage_key=$1", [row.storage_key]);
        } catch (error) {
          recordFailure(error);
        }
      }
    }
  } catch (error) {
    recordFailure(error);
  }
  if (failures) console.warn("[attachments] cleanup deferred", { failures, code });
}
