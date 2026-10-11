import { AuthAttemptStatusSchema } from "@/lib/ai-auth-flow";
import { WebAuthProviderSchema } from "@/lib/ai-auth";
import type { SQLiteExecutor } from "@/server/db/sqlite";
import { sqliteTimestamp, sqliteUuid } from "@/server/db/sqlite/values";
import { ApiError } from "@/server/http";
import { aiAuthCopy } from "@/server/i18n/ai-auth-copy";
import type { AuthAttemptRow } from "./attempt-data";

export function sqliteAuthAttempt(executor: SQLiteExecutor, id: string): AuthAttemptRow {
  const row = executor.get<{
    id: string; provider: string; scope_key: string; browser_hash: string; status: string;
    payload: string; expires_at: string; next_poll_at: string | null;
  }>("SELECT * FROM ai_auth_attempts WHERE id=?", [sqliteUuid(id)]);
  if (!row) throw new ApiError("not_found", aiAuthCopy.attemptGone);
  return {
    ...row, provider: WebAuthProviderSchema.parse(row.provider), status: AuthAttemptStatusSchema.parse(row.status),
    payload: JSON.parse(row.payload), expires_at: new Date(row.expires_at),
    next_poll_at: row.next_poll_at ? new Date(row.next_poll_at) : null,
  };
}

export function saveSQLiteAuthAttempt(executor: SQLiteExecutor, attempt: AuthAttemptRow): void {
  executor.run(
    "UPDATE ai_auth_attempts SET status=?,payload=?,expires_at=?,next_poll_at=? WHERE id=?",
    [attempt.status, JSON.stringify(attempt.payload), sqliteTimestamp(attempt.expires_at),
      attempt.next_poll_at ? sqliteTimestamp(attempt.next_poll_at) : null, attempt.id],
  );
}
