import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { query, queryOne, tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { sqliteTimestamp } from "@/server/db/sqlite/values";
import { ApiError } from "@/server/http";

export const shareInput = z.object({
  expiresInHours: z.number().int().min(1).max(168).default(24),
  confirmed: z.literal(true),
}).strict();
export const capabilityPattern = /^[0-9a-f]{64}$/;
const idSchema = z.uuid().transform((id) => id.toLowerCase());
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export type ShareSummary = {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
};
type Row = { id: string; created_at: Date | string; expires_at: Date | string; revoked_at: Date | string | null };
const summary = (row: Row): ShareSummary => ({
  id: row.id, createdAt: new Date(row.created_at).toISOString(),
  expiresAt: new Date(row.expires_at).toISOString(),
  revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
});
const missing = () => new ApiError("not_found", { ko: "공유를 찾을 수 없습니다.", en: "Share not found." });
const ownerClause = "owner_id=(SELECT id FROM users ORDER BY created_at,id LIMIT 1)";

/** The clock is supplied by deterministic tests; production uses request time. */
export async function createShare(
  input: { readonly noteId: string; readonly ownerId: string; readonly expiresInHours: number; readonly confirmed: true },
  now = new Date(),
): Promise<{ share: ShareSummary; path: string }> {
  const { expiresInHours } = shareInput.parse({ expiresInHours: input.expiresInHours, confirmed: input.confirmed });
  const noteId = idSchema.parse(input.noteId);
  const ownerId = idSchema.parse(input.ownerId);
  const token = randomBytes(32).toString("hex");
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + expiresInHours * 3600_000);
  if (databaseBackend() === "sqlite") {
    const store = await sqliteStore();
    store.transaction((q) => {
      const owner = q.get("SELECT id FROM users WHERE id=? AND id=(SELECT id FROM users ORDER BY created_at,id LIMIT 1)", [ownerId]);
      if (!owner) throw new ApiError("forbidden", "Owner required");
      const note = q.get<{ title: string; body: string }>("SELECT title,body FROM notes WHERE id=? AND deleted_at IS NULL AND status<>'archived'", [noteId]);
      if (!note) throw missing();
      q.run("INSERT INTO note_shares(id,owner_id,note_id,token_hash,title,body,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)",
        [id, ownerId, noteId, hash(token), note.title, note.body, sqliteTimestamp(now), sqliteTimestamp(expiresAt)]);
    });
  } else {
    await tx(async (q) => {
      const owner = await q.query("SELECT id FROM users WHERE id=$1 AND id=(SELECT id FROM users ORDER BY created_at,id LIMIT 1)", [ownerId]);
      if (!owner.rows[0]) throw new ApiError("forbidden", "Owner required");
      const note = await q.query<{ title: string; body: string }>("SELECT title,body FROM notes WHERE id=$1 AND deleted_at IS NULL AND status<>'archived' FOR UPDATE", [noteId]);
      if (!note.rows[0]) throw missing();
      await q.query("INSERT INTO note_shares(id,owner_id,note_id,token_hash,title,body,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, ownerId, noteId, hash(token), note.rows[0].title, note.rows[0].body, now, expiresAt]);
    });
  }
  return { share: { id, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(), revokedAt: null }, path: `/share/${token}` };
}

export async function listShares(noteId: string, ownerId: string): Promise<ShareSummary[]> {
  const ids = [idSchema.parse(noteId), idSchema.parse(ownerId)];
  const columns = "id,created_at,expires_at,revoked_at";
  const rows = databaseBackend() === "sqlite"
    ? (await sqliteStore()).all<Row>(`SELECT ${columns} FROM note_shares WHERE note_id=? AND owner_id=? AND ${ownerClause} ORDER BY created_at DESC,id`, ids)
    : await query<Row>(`SELECT ${columns} FROM note_shares WHERE note_id=$1 AND owner_id=$2 AND ${ownerClause} ORDER BY created_at DESC,id`, ids);
  return rows.map(summary);
}

export async function revokeShare(input: { readonly noteId: string; readonly ownerId: string; readonly shareId: string }, now = new Date()): Promise<void> {
  const ids = [idSchema.parse(input.noteId), idSchema.parse(input.ownerId), idSchema.parse(input.shareId)];
  const predicate = `AND ${ownerClause}`;
  const row = databaseBackend() === "sqlite"
    ? (await sqliteStore()).get(`UPDATE note_shares SET revoked_at=COALESCE(revoked_at,?) WHERE note_id=? AND owner_id=? AND id=? ${predicate} RETURNING id`, [sqliteTimestamp(now), ...ids])
    : await queryOne(`UPDATE note_shares SET revoked_at=COALESCE(revoked_at,$4) WHERE note_id=$1 AND owner_id=$2 AND id=$3 ${predicate} RETURNING id`, [...ids, now]);
  if (!row) throw missing();
}

export type SharedSnapshot = { readonly title: string; readonly body: string; readonly expiresAt: string };
export async function readShare(token: string, now = new Date()): Promise<SharedSnapshot | null> {
  if (!capabilityPattern.test(token)) return null;
  const sql = `SELECT s.title,s.body,s.expires_at FROM note_shares s JOIN notes n ON n.id=s.note_id
    WHERE s.token_hash=PARAM1 AND s.expires_at>PARAM2 AND s.revoked_at IS NULL
    AND n.deleted_at IS NULL AND n.status<>'archived'`;
  type SnapshotRow = { title: string; body: string; expires_at: Date | string };
  const row = databaseBackend() === "sqlite"
    ? (await sqliteStore()).transaction((q) => q.get<SnapshotRow>(sql.replace("PARAM1", "?").replace("PARAM2", "?"), [hash(token), sqliteTimestamp(now)]))
    : await tx(async (q) => (await q.query<SnapshotRow>(sql.replace("PARAM1", "$1").replace("PARAM2", "$2") + " FOR SHARE OF n,s", [hash(token), now])).rows[0] ?? null);
  return row ? { title: row.title, body: row.body, expiresAt: new Date(row.expires_at).toISOString() } : null;
}
