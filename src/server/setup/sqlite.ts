import { emptyAiSettingsDocument } from "@/lib/ai-settings";
import { readSQLiteBoolean, sqliteTimestamp, type SQLiteExecutor, type SQLiteStore } from "@/server/db/sqlite";
import { ApiError } from "@/server/http";
import { setupCopy } from "@/server/i18n/setup-copy";
import { OCCUPIED_SQL } from "./access";

/** EXISTS/OR are SQLite-native too; their integer result needs explicit conversion. */
export function sqliteOccupied(executor: SQLiteExecutor): boolean {
  const row = executor.get<{ occupied: bigint }>(OCCUPIED_SQL);
  return row ? readSQLiteBoolean(row.occupied) : false;
}

export function completeSQLiteSetup(store: SQLiteStore, passwordHash: string, scopeKey: string): void {
  store.transaction((executor) => {
    if (process.env.AUTH_PASSWORD_HASH?.trim() || sqliteOccupied(executor)) {
      throw new ApiError("conflict", setupCopy.hasData);
    }
    const now = sqliteTimestamp(new Date());
    const owner = executor.get<{ id: string }>(
      "INSERT INTO users (password_hash, created_at, updated_at) VALUES (?, ?, ?) RETURNING id",
      [passwordHash, now, now],
    );
    if (!owner) throw new ApiError("internal", setupCopy.saveFailed);
    executor.run(
      `INSERT INTO installation_settings (singleton, owner_id, setup_completed, ai, updated_at)
       VALUES (1, ?, 1, ?, ?)`,
      [owner.id, JSON.stringify(emptyAiSettingsDocument()), now],
    );
    executor.run("DELETE FROM ai_auth_attempts WHERE scope_key = ?", [scopeKey]);
  });
}
