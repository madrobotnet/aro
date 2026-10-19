import { sqliteStore } from "@/server/db/backend";
import { sqliteTimestamp, type SQLiteExecutor } from "@/server/db/sqlite";
import { ApiError } from "@/server/http";
import {
  connectionDto, expired, newAuthorization, pkceMatches, scopeList, tokenPair,
  type Authorization, type ClientRow, type CodeRow, type ConnectionRow, type Exchange,
  type GrantRow, type RefreshRow, type TokenResponse,
} from "./model";
import type { AgentScope } from "@/lib/agent-access";

export async function register(client: ClientRow): Promise<void> {
  (await sqliteStore()).run(`INSERT INTO oauth_clients(id,name,redirect_uris,created_at,auth_method,secret_hash)
    VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,redirect_uris=excluded.redirect_uris`,
    [client.id, client.name, client.redirect_uris, sqliteTimestamp(client.created_at), client.auth_method, client.secret_hash]);
}
export async function findClient(id: string): Promise<ClientRow | null> {
  return (await sqliteStore()).get<ClientRow>("SELECT * FROM oauth_clients WHERE id=?", [id]);
}
export async function consumeRate(key: string, windowMs: number, limit: number): Promise<boolean> {
  const now = new Date();
  const since = sqliteTimestamp(new Date(now.getTime() - windowMs));
  const result = (await sqliteStore()).get<{ attempts: bigint }>(`INSERT INTO oauth_rate_limits(key,started_at,attempts)
    VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET
    attempts=CASE WHEN started_at<=? THEN 1 ELSE attempts+1 END,
    started_at=CASE WHEN started_at<=? THEN excluded.started_at ELSE started_at END
    RETURNING attempts`, [key, sqliteTimestamp(now), since, since]);
  return Number(result?.attempts ?? limit + 1) <= limit;
}
export async function issueCode(auth: Authorization, ownerId: string, scopes: readonly AgentScope[]): Promise<string> {
  const created = newAuthorization(auth, ownerId, scopes);
  (await sqliteStore()).transaction(q => {
    const g = created.grant;
    q.run(`INSERT INTO oauth_grants(id,owner_id,client_id,resource,scopes,allowed_note_ids,created_at)
      VALUES (?,?,?,?,?,?,?)`, [g.id, g.owner_id, g.client_id, g.resource, g.scopes, g.allowed_note_ids, sqliteTimestamp(g.created_at)]);
    const c = created.row;
    q.run(`INSERT INTO oauth_codes(code_hash,grant_id,redirect_uri,code_challenge,expires_at)
      VALUES (?,?,?,?,?)`, [c.code_hash, c.grant_id, c.redirect_uri, c.code_challenge, sqliteTimestamp(c.expires_at)]);
  });
  return created.code;
}
function revoke(q: SQLiteExecutor, id: string): void {
  const now = sqliteTimestamp(new Date());
  q.run("UPDATE oauth_grants SET revoked_at=coalesce(revoked_at,?) WHERE id=?", [now, id]);
  q.run("UPDATE agent_tokens SET revoked_at=coalesce(revoked_at,?) WHERE oauth_grant_id=?", [now, id]);
}
export async function exchange(input: Exchange): Promise<TokenResponse | null> {
  return (await sqliteStore()).transaction(q => {
    const source = input.kind === "code"
      ? q.get<CodeRow>("SELECT * FROM oauth_codes WHERE code_hash=?", [input.hash])
      : q.get<RefreshRow>("SELECT * FROM oauth_refresh_tokens WHERE token_hash=?", [input.hash]);
    if (!source) return null;
    const grant = q.get<GrantRow>("SELECT * FROM oauth_grants WHERE id=?", [source.grant_id]);
    if (!grant || grant.revoked_at || grant.client_id !== input.clientId || grant.resource !== input.resource) return null;
    let scopes = scopeList(grant.scopes);
    switch (input.kind) {
      case "code": {
        const code = q.get<CodeRow>("SELECT * FROM oauth_codes WHERE code_hash=?", [input.hash]);
        if (!code || code.redirect_uri !== input.redirectUri || !pkceMatches(input.verifier, code.code_challenge)) return null;
        if (code.consumed_at) { revoke(q, grant.id); return null; }
        if (expired(code.expires_at, input.now)) return null;
        q.run("UPDATE oauth_codes SET consumed_at=? WHERE code_hash=?", [sqliteTimestamp(input.now), input.hash]);
        break;
      }
      case "refresh": {
        const refresh = q.get<RefreshRow>("SELECT * FROM oauth_refresh_tokens WHERE token_hash=?", [input.hash]);
        if (!refresh) return null;
        if (refresh.consumed_at) { revoke(q, grant.id); return null; }
        if (expired(refresh.expires_at, input.now)) return null;
        if (input.scopes) {
          if (input.scopes.some(scope => !scopes.includes(scope))) return null;
          scopes = [...input.scopes];
          q.run("UPDATE oauth_grants SET scopes=? WHERE id=?", [JSON.stringify(scopes), grant.id]);
          q.run("UPDATE agent_tokens SET scopes=? WHERE oauth_grant_id=?", [JSON.stringify(scopes), grant.id]);
        }
        q.run("UPDATE oauth_refresh_tokens SET consumed_at=? WHERE token_hash=?", [sqliteTimestamp(input.now), input.hash]);
        break;
      }
    }
    const client = q.get<ClientRow>("SELECT * FROM oauth_clients WHERE id=?", [grant.client_id]);
    if (!client) throw new ApiError("internal", "OAuth client is missing");
    const pair = tokenPair(grant, client.name, input.now, scopes);
    const t = pair.access.row;
    q.run(`INSERT INTO agent_tokens(id,owner_id,name,prefix,token_hash,scopes,allowed_note_ids,expires_at,oauth_grant_id,resource)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [t.id, t.owner_id, t.name, t.prefix, pair.access.hash,
      t.scopes, t.allowed_note_ids, sqliteTimestamp(pair.accessExpires), grant.id, grant.resource]);
    q.run("INSERT INTO oauth_refresh_tokens(token_hash,grant_id,expires_at) VALUES (?,?,?)",
      [pair.refreshHash, grant.id, sqliteTimestamp(pair.refreshExpires)]);
    return pair.response;
  });
}
export async function revokeSecret(hash: string, clientId?: string): Promise<void> {
  (await sqliteStore()).transaction(q => {
    const found = q.get<{ grant_id: string }>(`SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash=?
      UNION SELECT oauth_grant_id AS grant_id FROM agent_tokens WHERE token_hash=? AND oauth_grant_id IS NOT NULL`, [hash, hash]);
    if (!found) return;
    const grant = q.get<GrantRow>("SELECT * FROM oauth_grants WHERE id=?", [found.grant_id]);
    if (grant && (clientId === undefined || clientId === grant.client_id)) revoke(q, grant.id);
  });
}
export async function listConnections(ownerId: string) {
  return (await sqliteStore()).all<ConnectionRow>(`SELECT g.*,c.name,
    (SELECT max(t.last_used_at) FROM agent_tokens t WHERE t.oauth_grant_id=g.id) AS last_used_at
    FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.owner_id=?
    ORDER BY g.created_at DESC,g.id DESC`, [ownerId]).map(connectionDto);
}
export async function revokeConnection(id: string, ownerId: string): Promise<void> {
  (await sqliteStore()).transaction(q => {
    const row = q.get<GrantRow>("SELECT * FROM oauth_grants WHERE id=? AND owner_id=?", [id, ownerId]);
    if (!row) throw new ApiError("not_found", "OAuth connection not found");
    revoke(q, row.id);
  });
}
export async function updateAllowedNotes(id: string, ownerId: string, noteIds: readonly string[]): Promise<void> {
  (await sqliteStore()).transaction(q => {
    const grant = q.get<GrantRow>("SELECT * FROM oauth_grants WHERE id=? AND owner_id=?", [id, ownerId]);
    if (!grant || grant.revoked_at) throw new ApiError("not_found", "OAuth connection not found");
    if (!scopeList(grant.scopes).includes("propose-write")) throw new ApiError("forbidden", "Connection does not allow proposals");
    for (const noteId of noteIds) {
      if (!q.get("SELECT id FROM notes WHERE id=? AND deleted_at IS NULL", [noteId])) {
        throw new ApiError("not_found", "Active note not found");
      }
    }
    q.run("UPDATE oauth_grants SET allowed_note_ids=? WHERE id=?", [JSON.stringify(noteIds), id]);
    q.run("UPDATE agent_tokens SET allowed_note_ids=? WHERE oauth_grant_id=?", [JSON.stringify(noteIds), id]);
  });
}
