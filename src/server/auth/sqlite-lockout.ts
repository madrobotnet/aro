import { readSQLiteNumber, sqliteTimestamp, type SQLiteExecutor } from "@/server/db/sqlite";
import { LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW_MIN } from "./config";
import type { LoginResult } from "./lockout";

function recentFailures(executor: SQLiteExecutor, clientKey: string, now: number) {
  const row = executor.get<{ attempts: bigint; oldest: string | null }>(
    `SELECT count(*) AS attempts, min(attempted_at) AS oldest
     FROM auth_login_failures WHERE client_key = ? AND attempted_at > ?`,
    [clientKey, sqliteTimestamp(new Date(now - LOGIN_FAIL_WINDOW_MIN * 60_000))],
  );
  return {
    count: row ? readSQLiteNumber(row.attempts) : 0,
    remaining: row?.oldest
      ? Math.max(1, Math.ceil((Date.parse(row.oldest) + LOGIN_FAIL_WINDOW_MIN * 60_000 - now) / 1000))
      : LOGIN_FAIL_WINDOW_MIN * 60,
  };
}

export function sqliteLoginLock(executor: SQLiteExecutor, clientKey: string, now: number): LoginResult | null {
  const recent = recentFailures(executor, clientKey, now);
  return recent.count >= LOGIN_FAIL_LIMIT ? { kind: "locked", retryAfterSeconds: recent.remaining } : null;
}

/** Must run under BEGIN IMMEDIATE: verification never reserves the writer. */
export function recordSQLiteLogin(
  executor: SQLiteExecutor, clientKey: string, matches: boolean, now: number,
): LoginResult {
  const recent = recentFailures(executor, clientKey, now);
  if (recent.count >= LOGIN_FAIL_LIMIT) return { kind: "locked", retryAfterSeconds: recent.remaining };
  if (matches) {
    executor.run("DELETE FROM auth_login_failures WHERE client_key = ?", [clientKey]);
    return { kind: "accepted" };
  }
  executor.run("INSERT INTO auth_login_failures (client_key, attempted_at) VALUES (?, ?)",
    [clientKey, sqliteTimestamp(new Date(now))]);
  executor.run("DELETE FROM auth_login_failures WHERE attempted_at < ?",
    [sqliteTimestamp(new Date(now - 86_400_000))]);
  return recent.count + 1 >= LOGIN_FAIL_LIMIT
    ? { kind: "locked", retryAfterSeconds: recent.remaining }
    : { kind: "wrong_password" };
}
