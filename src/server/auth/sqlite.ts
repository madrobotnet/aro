import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { sqliteTimestamp, type SQLiteStore } from "@/server/db/sqlite";
import { sessionTtlDays } from "./config";

/** SQLite TEXT does not perform PostgreSQL inet validation or canonicalization. */
function sessionIp(ip: string | null): string | null {
  if (ip === null) return null;
  const family = isIP(ip);
  if (!family) throw new TypeError("Session IP must be an IPv4 or IPv6 address");
  return family === 6 ? new URL(`http://[${ip}]`).hostname.slice(1, -1) : ip;
}

export function createSQLiteSession(store: SQLiteStore, input: {
  readonly passwordHash: string;
  readonly userAgent: string | null;
  readonly ip: string | null;
}): { token: string; expiresAt: Date } {
  const ip = sessionIp(input.ip);
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const timestamp = sqliteTimestamp(now);
  const expiresAt = new Date(now.getTime() + sessionTtlDays() * 86_400_000);
  store.transaction((executor) => {
    let owner = executor.get<{ id: string }>("SELECT id FROM users ORDER BY created_at, id LIMIT 1");
    if (owner) {
      executor.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
        [input.passwordHash, timestamp, owner.id]);
    } else {
      owner = executor.get<{ id: string }>(
        "INSERT INTO users (password_hash, created_at, updated_at) VALUES (?, ?, ?) RETURNING id",
        [input.passwordHash, timestamp, timestamp],
      );
    }
    if (!owner) throw new Error("failed to create owner");
    executor.run(
      `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [owner.id, createHash("sha256").update(token).digest(), sqliteTimestamp(expiresAt),
        input.userAgent, ip, timestamp, timestamp],
    );
  });
  return { token, expiresAt };
}
