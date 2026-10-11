import { aiAuthCopy } from "@/server/i18n/ai-auth-copy";
import { ConnectionProfileSchema, type ConnectionProfile } from "@/lib/ai-settings";
import type { AuthProtocolOptions } from "@/lib/ai-auth";
import { tx } from "@/server/db";
import { databaseBackend } from "@/server/db/backend";
import { refreshedSQLiteConnectionProfile } from "./sqlite-refresh";
import { ApiError } from "@/server/http";
import { AI_SETTINGS_LOCK } from "@/server/setup/ai-profile-store";
import { OAuthProtocolError, refreshCredential } from "./protocol";

/** Serialize refresh with edits/deletion and re-read before replacing credentials. */
export async function refreshedConnectionProfile(
  id: string,
  options: AuthProtocolOptions & { readonly forceIfAccessToken?: string } = {},
): Promise<ConnectionProfile | null> {
  if (databaseBackend() === "sqlite") return refreshedSQLiteConnectionProfile(id, options);
  return tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [AI_SETTINGS_LOCK]);
    const result = await client.query<{ id: string; name: string; purpose: string; connection: unknown }>(
      `SELECT id, name, purpose, connection FROM ai_connections
       WHERE id = $1 AND owner_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) FOR UPDATE`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const profile = ConnectionProfileSchema.parse(row);
    if (profile.connection.mode !== "auth") return profile;
    const credential = profile.connection.credential;
    if (!credential || credential.provider === "openrouter" || credential.provider === "google") return profile;
    const force = options.forceIfAccessToken !== undefined && credential.accessToken === options.forceIfAccessToken;
    if (!force && (credential.expiresAt === undefined
      || credential.expiresAt > (options.now ?? Date.now)() + 60_000)) return profile;
    try {
      const refreshed = await refreshCredential(credential, options);
      const updated = ConnectionProfileSchema.parse({
        ...profile, connection: { ...profile.connection, credential: refreshed },
      });
      await client.query(
        "UPDATE ai_connections SET connection = $2::jsonb, updated_at = now() WHERE id = $1",
        [id, JSON.stringify(updated.connection)],
      );
      return updated;
    } catch (error) {
      if (!(error instanceof OAuthProtocolError)) throw error;
      throw new ApiError("unavailable", aiAuthCopy.refreshFailed);
    }
  });
}
