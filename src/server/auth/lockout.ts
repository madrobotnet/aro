import argon2 from "argon2";
import { tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW_MIN } from "./config";

export type LoginResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "wrong_password" }
  | { readonly kind: "locked"; readonly retryAfterSeconds: number };

/** The lock spans verification and the failure write, including across workers. */
export async function verifyLogin(input: {
  readonly clientKey: string;
  readonly password: string;
  readonly hash: string;
}): Promise<LoginResult> {
  if (databaseBackend() === "sqlite") {
    const { sqliteLoginLock, recordSQLiteLogin } = await import("./sqlite-lockout");
    const store = await sqliteStore();
    const locked = sqliteLoginLock(store, input.clientKey, Date.now());
    if (locked) return locked;
    // Argon2 releases the thread; recheck under the writer lock after it completes.
    const matches = await argon2.verify(input.hash, input.password);
    return store.transaction((executor) => recordSQLiteLogin(executor, input.clientKey, matches, Date.now()));
  }
  return tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7431002))", [input.clientKey]);
    const recent = await client.query<{ attempts: number; remaining: number }>(
      `SELECT count(*)::int attempts,
        coalesce(ceil(extract(epoch FROM
          min(attempted_at) + make_interval(mins => $2) - clock_timestamp())), 0)::int remaining
       FROM auth_login_failures
       WHERE client_key = $1 AND attempted_at > clock_timestamp() - make_interval(mins => $2)`,
      [input.clientKey, LOGIN_FAIL_WINDOW_MIN],
    );
    const count = recent.rows[0]?.attempts ?? 0;
    const remaining = Math.max(1, recent.rows[0]?.remaining ?? 1);
    if (count >= LOGIN_FAIL_LIMIT) return { kind: "locked", retryAfterSeconds: remaining };

    // Malformed server-side hash configuration is an operational error, not a bad password.
    const matches = await argon2.verify(input.hash, input.password);
    if (matches) {
      await client.query("DELETE FROM auth_login_failures WHERE client_key = $1", [input.clientKey]);
      return { kind: "accepted" };
    }
    await client.query(
      "INSERT INTO auth_login_failures (client_key, attempted_at) VALUES ($1, clock_timestamp())",
      [input.clientKey],
    );
    await client.query("DELETE FROM auth_login_failures WHERE attempted_at < now() - interval '1 day'");
    // Return rather than throw inside the transaction: failed attempts must commit.
    return count + 1 >= LOGIN_FAIL_LIMIT
      ? { kind: "locked", retryAfterSeconds: count ? remaining : LOGIN_FAIL_WINDOW_MIN * 60 }
      : { kind: "wrong_password" };
  });
}
