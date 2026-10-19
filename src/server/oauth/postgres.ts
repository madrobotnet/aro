import type { PoolClient } from "pg";
import { db, tx } from "@/server/db";
import { ApiError } from "@/server/http";
import {
  connectionDto, expired, newAuthorization, pkceMatches, scopeList, tokenPair,
  type Authorization, type ClientRow, type CodeRow, type ConnectionRow, type Exchange,
  type GrantRow, type RefreshRow, type TokenResponse,
} from "./model";
import type { AgentScope } from "@/lib/agent-access";

export async function register(client: ClientRow): Promise<void> {
  await (await db()).query(`INSERT INTO oauth_clients(id,name,redirect_uris,created_at,auth_method,secret_hash)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,redirect_uris=excluded.redirect_uris`,
    [client.id, client.name, client.redirect_uris, client.created_at, client.auth_method, client.secret_hash]);
}
export async function findClient(id: string): Promise<ClientRow | null> {
  return (await (await db()).query<ClientRow>("SELECT * FROM oauth_clients WHERE id=$1", [id])).rows[0] ?? null;
}
export async function consumeRate(key: string, windowMs: number, limit: number): Promise<boolean> {
  const now = new Date();
  const result = await (await db()).query<{ attempts: number }>(`INSERT INTO oauth_rate_limits(key,started_at,attempts)
    VALUES ($1,$2,1) ON CONFLICT(key) DO UPDATE SET
    attempts=CASE WHEN oauth_rate_limits.started_at<=$3 THEN 1 ELSE oauth_rate_limits.attempts+1 END,
    started_at=CASE WHEN oauth_rate_limits.started_at<=$3 THEN $2 ELSE oauth_rate_limits.started_at END
    RETURNING attempts`, [key, now, new Date(now.getTime() - windowMs)]);
  return (result.rows[0]?.attempts ?? limit + 1) <= limit;
}
export async function issueCode(auth: Authorization, ownerId: string, scopes: readonly AgentScope[]): Promise<string> {
  const created = newAuthorization(auth, ownerId, scopes);
  await tx(async q => {
    const g = created.grant;
    await q.query(`INSERT INTO oauth_grants(id,owner_id,client_id,resource,scopes,allowed_note_ids,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [g.id, g.owner_id, g.client_id, g.resource, g.scopes, g.allowed_note_ids, g.created_at]);
    const c = created.row;
    await q.query(`INSERT INTO oauth_codes(code_hash,grant_id,redirect_uri,code_challenge,expires_at)
      VALUES ($1,$2,$3,$4,$5)`, [c.code_hash, c.grant_id, c.redirect_uri, c.code_challenge, c.expires_at]);
  });
  return created.code;
}

/** All grant mutations lock the grant first, then its agent tokens. */
async function revoke(q: PoolClient, id: string): Promise<void> {
  await q.query("UPDATE oauth_grants SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1", [id]);
  await q.query("UPDATE agent_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE oauth_grant_id=$1", [id]);
}
export async function exchange(input: Exchange): Promise<TokenResponse | null> {
  return tx(async q => {
    const source = input.kind === "code"
      ? (await q.query<CodeRow>("SELECT * FROM oauth_codes WHERE code_hash=$1", [input.hash])).rows[0]
      : (await q.query<RefreshRow>("SELECT * FROM oauth_refresh_tokens WHERE token_hash=$1", [input.hash])).rows[0];
    if (!source) return null;
    const grant = (await q.query<GrantRow>("SELECT * FROM oauth_grants WHERE id=$1 FOR UPDATE", [source.grant_id])).rows[0];
    if (!grant || grant.revoked_at || grant.client_id !== input.clientId || grant.resource !== input.resource) return null;
    let scopes = scopeList(grant.scopes);
    switch (input.kind) {
      case "code": {
        // Re-read after the grant lock: concurrent exchanges must observe consumption.
        const code = (await q.query<CodeRow>("SELECT * FROM oauth_codes WHERE code_hash=$1", [input.hash])).rows[0];
        if (!code || code.redirect_uri !== input.redirectUri || !pkceMatches(input.verifier, code.code_challenge)) return null;
        if (code.consumed_at) { await revoke(q, grant.id); return null; }
        if (expired(code.expires_at, input.now)) return null;
        await q.query("UPDATE oauth_codes SET consumed_at=$2 WHERE code_hash=$1", [input.hash, input.now]);
        break;
      }
      case "refresh": {
        const refresh = (await q.query<RefreshRow>("SELECT * FROM oauth_refresh_tokens WHERE token_hash=$1", [input.hash])).rows[0];
        if (!refresh) return null;
        if (refresh.consumed_at) { await revoke(q, grant.id); return null; }
        if (expired(refresh.expires_at, input.now)) return null;
        if (input.scopes) {
          if (input.scopes.some(scope => !scopes.includes(scope))) return null;
          scopes = [...input.scopes];
          // A reduced refresh grant stays reduced on all subsequent rotations.
          await q.query("UPDATE oauth_grants SET scopes=$2 WHERE id=$1", [grant.id, JSON.stringify(scopes)]);
          await q.query("UPDATE agent_tokens SET scopes=$2 WHERE oauth_grant_id=$1", [grant.id, JSON.stringify(scopes)]);
        }
        await q.query("UPDATE oauth_refresh_tokens SET consumed_at=$2 WHERE token_hash=$1", [input.hash, input.now]);
        break;
      }
    }
    const client = (await q.query<ClientRow>("SELECT * FROM oauth_clients WHERE id=$1", [grant.client_id])).rows[0];
    if (!client) throw new ApiError("internal", "OAuth client is missing");
    const pair = tokenPair(grant, client.name, input.now, scopes);
    const t = pair.access.row;
    await q.query(`INSERT INTO agent_tokens(id,owner_id,name,prefix,token_hash,scopes,allowed_note_ids,expires_at,oauth_grant_id,resource)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [t.id, t.owner_id, t.name, t.prefix, pair.access.hash,
      t.scopes, t.allowed_note_ids, pair.accessExpires, grant.id, grant.resource]);
    await q.query("INSERT INTO oauth_refresh_tokens(token_hash,grant_id,expires_at) VALUES ($1,$2,$3)",
      [pair.refreshHash, grant.id, pair.refreshExpires]);
    return pair.response;
  });
}
export async function revokeSecret(hash: string, clientId?: string): Promise<void> {
  await tx(async q => {
    const found = (await q.query<{ grant_id: string }>(`SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash=$1
      UNION SELECT oauth_grant_id AS grant_id FROM agent_tokens WHERE token_hash=$1 AND oauth_grant_id IS NOT NULL`, [hash])).rows[0];
    if (!found) return;
    const grant = (await q.query<GrantRow>("SELECT * FROM oauth_grants WHERE id=$1 FOR UPDATE", [found.grant_id])).rows[0];
    if (grant && (clientId === undefined || clientId === grant.client_id)) await revoke(q, grant.id);
  });
}
export async function listConnections(ownerId: string) {
  return (await (await db()).query<ConnectionRow>(`SELECT g.*,c.name,
    (SELECT max(t.last_used_at) FROM agent_tokens t WHERE t.oauth_grant_id=g.id) AS last_used_at
    FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.owner_id=$1
    ORDER BY g.created_at DESC,g.id DESC`, [ownerId])).rows.map(connectionDto);
}
export async function revokeConnection(id: string, ownerId: string): Promise<void> {
  await tx(async q => {
    const row = (await q.query<GrantRow>("SELECT * FROM oauth_grants WHERE id=$1 AND owner_id=$2 FOR UPDATE", [id, ownerId])).rows[0];
    if (!row) throw new ApiError("not_found", "OAuth connection not found");
    await revoke(q, row.id);
  });
}
export async function updateAllowedNotes(id: string, ownerId: string, noteIds: readonly string[]): Promise<void> {
  await tx(async q => {
    const grant = (await q.query<GrantRow>("SELECT * FROM oauth_grants WHERE id=$1 AND owner_id=$2 FOR UPDATE", [id, ownerId])).rows[0];
    if (!grant || grant.revoked_at) throw new ApiError("not_found", "OAuth connection not found");
    if (!scopeList(grant.scopes).includes("propose-write")) throw new ApiError("forbidden", "Connection does not allow proposals");
    for (const noteId of noteIds) {
      if (!(await q.query("SELECT id FROM notes WHERE id=$1 AND deleted_at IS NULL", [noteId])).rowCount) {
        throw new ApiError("not_found", "Active note not found");
      }
    }
    await q.query("UPDATE oauth_grants SET allowed_note_ids=$2 WHERE id=$1", [id, JSON.stringify(noteIds)]);
    await q.query("UPDATE agent_tokens SET allowed_note_ids=$2 WHERE oauth_grant_id=$1", [id, JSON.stringify(noteIds)]);
  });
}
