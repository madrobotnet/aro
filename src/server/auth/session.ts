import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { query, queryOne, tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { SESSION_COOKIE, sessionTtlDays } from "./config";

export type Session = { id: string; userId: string; expiresAt: string };

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Single-owner app: one users row holds the current password hash. */
async function ownerId(passwordHash: string): Promise<string> {
  return tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(7431003)");
    const result = await client.query<{ id: string }>("SELECT id FROM users ORDER BY created_at, id LIMIT 1");
    const existing = result.rows[0];
    if (existing) {
      await client.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [existing.id, passwordHash]);
      return existing.id;
    }
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO users (password_hash) VALUES ($1) RETURNING id",
      [passwordHash],
    );
    const owner = inserted.rows[0];
    if (!owner) throw new Error("failed to create owner");
    return owner.id;
  });
}

export async function createSession(input: {
  passwordHash: string;
  userAgent: string | null;
  ip: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  if (databaseBackend() === "sqlite") {
    const { createSQLiteSession } = await import("./sqlite");
    return createSQLiteSession(await sqliteStore(), input);
  }
  const userId = await ownerId(input.passwordHash);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionTtlDays() * 86_400_000);
  await query(
    "INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5::inet)",
    [userId, hashToken(token), expiresAt, input.userAgent, input.ip],
  );
  return { token, expiresAt };
}

export async function sessionFromToken(token: string): Promise<Session | null> {
  if (databaseBackend() === "sqlite") {
    const { sqliteTimestamp } = await import("@/server/db/sqlite");
    const store = await sqliteStore();
    const now = sqliteTimestamp(new Date());
    const row = store.get<{ id: string; user_id: string; expires_at: string }>(
      `UPDATE sessions SET last_seen_at = ?
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
       RETURNING id, user_id, expires_at`,
      [now, hashToken(token), now],
    );
    return row ? { id: row.id, userId: row.user_id, expiresAt: new Date(row.expires_at).toISOString() } : null;
  }
  const row = await queryOne<{ id: string; user_id: string; expires_at: Date }>(
    `UPDATE sessions SET last_seen_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, user_id, expires_at`,
    [hashToken(token)],
  );
  return row ? { id: row.id, userId: row.user_id, expiresAt: row.expires_at.toISOString() } : null;
}

export async function revokeToken(token: string): Promise<void> {
  if (databaseBackend() === "sqlite") {
    const { sqliteTimestamp } = await import("@/server/db/sqlite");
    (await sqliteStore()).run(
      "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      [sqliteTimestamp(new Date()), hashToken(token)],
    );
    return;
  }
  await query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [hashToken(token)]);
}

export async function revokeAllSessions(): Promise<number> {
  if (databaseBackend() === "sqlite") {
    const { sqliteTimestamp, readSQLiteNumber } = await import("@/server/db/sqlite");
    const result = (await sqliteStore()).run(
      "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL", [sqliteTimestamp(new Date())],
    );
    return typeof result.changes === "bigint" ? readSQLiteNumber(result.changes) : result.changes;
  }
  const rows = await query<{ id: string }>("UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL RETURNING id");
  return rows.length;
}

/** Current request's session (reads the cookie). Null when missing/expired/revoked. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return sessionFromToken(token);
}
