import { ConnectionProfileSchema, type ConnectionProfile } from "@/lib/ai-settings";
import type { AuthProtocolOptions } from "@/lib/ai-auth";
import { sqliteStore } from "@/server/db/backend";
import type { SQLiteExecutor } from "@/server/db/sqlite";
import { sqliteTimestamp, sqliteUuid } from "@/server/db/sqlite/values";
import { ApiError } from "@/server/http";
import { aiAuthCopy } from "@/server/i18n/ai-auth-copy";
import { OAuthProtocolError, refreshCredential } from "./protocol";

function ownedProfile(executor: SQLiteExecutor, id: string): ConnectionProfile | null {
  const row = executor.get<{ id: string; name: string; purpose: string; connection: string }>(
    `SELECT id,name,purpose,connection FROM ai_connections
     WHERE id=? AND owner_id=(SELECT id FROM users ORDER BY created_at,id LIMIT 1)`, [id],
  );
  return row ? ConnectionProfileSchema.parse({ ...row, connection: JSON.parse(row.connection) }) : null;
}

/** Refresh reservations use the existing attempt journal, but a separate,
 * unclaimable internal scope. Never expire an ambiguous rotating-token POST:
 * reconnecting/editing the profile invalidates its old reservation instead. */
const activeRefreshes = new Map<string, Promise<ConnectionProfile | null>>();

export async function refreshedSQLiteConnectionProfile(
  id: string, options: AuthProtocolOptions & { readonly forceIfAccessToken?: string } = {},
): Promise<ConnectionProfile | null> {
  const normalized = sqliteUuid(id);
  const active = activeRefreshes.get(normalized);
  if (active) return active;
  const refreshing = refreshSQLiteProfile(normalized, options);
  activeRefreshes.set(normalized, refreshing);
  try {
    return await refreshing;
  } finally {
    activeRefreshes.delete(normalized);
  }
}

async function refreshSQLiteProfile(
  normalized: string, options: AuthProtocolOptions & { readonly forceIfAccessToken?: string },
): Promise<ConnectionProfile | null> {
  const store = await sqliteStore();
  const scope = `refresh:${normalized}`;
  const result = store.transaction(executor => {
    const profile = ownedProfile(executor, normalized);
    if (!profile || profile.connection.mode !== "auth") return { profile, claim: null };
    const credential = profile.connection.credential;
    if (!credential || credential.provider === "openrouter" || credential.provider === "google") {
      return { profile, claim: null };
    }
    const force = options.forceIfAccessToken !== undefined && credential.accessToken === options.forceIfAccessToken;
    if (!force && (credential.expiresAt === undefined || credential.expiresAt > (options.now ?? Date.now)() + 60_000)) {
      return { profile, claim: null };
    }
    const baseline = JSON.stringify(credential);
    const pending = executor.get<{ id: string; payload: string }>(
      "SELECT id,payload FROM ai_auth_attempts WHERE scope_key=?", [scope],
    );
    if (pending?.payload === baseline) throw new ApiError("unavailable", aiAuthCopy.refreshFailed);
    // An edit/reconnect invalidates the old worker's compare-and-swap.
    executor.run("DELETE FROM ai_auth_attempts WHERE scope_key=?", [scope]);
    const claim = crypto.randomUUID();
    executor.run(
      `INSERT INTO ai_auth_attempts(id,provider,scope_key,browser_hash,status,payload,expires_at)
       VALUES (?,?,?,'internal-refresh','starting',?,?)`,
      [claim, credential.provider, scope, baseline, sqliteTimestamp("9999-12-31T23:59:59Z")],
    );
    return { profile, claim, credential, baseline };
  });
  if (!result.claim || !result.credential) return result.profile;
  let refreshed;
  try {
    refreshed = await refreshCredential(result.credential, options);
  } catch (error) {
    // Keep ambiguous failures durably reserved; an explicit unsuccessful HTTP
    // response can be retried without replaying a consumed refresh token.
    if (error instanceof OAuthProtocolError && error.status !== undefined
      && (error.status === 429 || error.status >= 500)) {
      store.run("DELETE FROM ai_auth_attempts WHERE id=?", [result.claim]);
    }
    if (error instanceof OAuthProtocolError) throw new ApiError("unavailable", aiAuthCopy.refreshFailed);
    throw error;
  }
  return store.transaction(executor => {
    const current = ownedProfile(executor, normalized);
    const claim = executor.get<{ id: string }>("SELECT id FROM ai_auth_attempts WHERE id=? AND scope_key=?",
      [result.claim, scope]);
    executor.run("DELETE FROM ai_auth_attempts WHERE id=?", [result.claim]);
    if (!current || !claim || current.connection.mode !== "auth"
      || JSON.stringify(current.connection.credential) !== result.baseline) return current;
    const updated = ConnectionProfileSchema.parse({
      ...current, connection: { ...current.connection, credential: refreshed },
    });
    executor.run("UPDATE ai_connections SET connection=?,updated_at=? WHERE id=?",
      [JSON.stringify(updated.connection), sqliteTimestamp(new Date((options.now ?? Date.now)())), normalized]);
    return updated;
  });
}
