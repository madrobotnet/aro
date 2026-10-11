import { ConnectionProfileSchema } from "@/lib/ai-settings";
import { createCliProvider, type CliProviderOptions } from "@/server/chat/cli-provider";
import { ChatProviderError, type ChatProvider } from "@/server/chat/provider";
import { sqliteStore } from "@/server/db/backend";
import { sqliteTimestamp, sqliteUuid } from "@/server/db/sqlite/values";
import type { SQLiteExecutor } from "@/server/db/sqlite";

function googleProfile(executor: SQLiteExecutor, id: string) {
  const row = executor.get<{ id: string; name: string; purpose: string; connection: string }>(
    `SELECT id,name,purpose,connection FROM ai_connections
     WHERE id=? AND owner_id=(SELECT id FROM users ORDER BY created_at,id LIMIT 1)`, [id],
  );
  if (!row) throw new ChatProviderError();
  const profile = ConnectionProfileSchema.parse({ ...row, connection: JSON.parse(row.connection) });
  if (profile.purpose !== "chat" || profile.connection.mode !== "auth" || profile.connection.provider !== "google"
    || profile.connection.credential?.provider !== "google") throw new ChatProviderError();
  return { profile, connection: profile.connection, credential: profile.connection.credential };
}

/** Keep filesystem/subprocess work outside the writer; reserve the profile's
 * credential first and compare it again when the CLI reads its isolated file back. */
export function createSQLiteGoogleProfileProvider(
  id: string, options: Omit<CliProviderOptions, "session"> = {},
): ChatProvider {
  return {
    async stream(input, onDelta, signal) {
      if (signal.aborted) throw new ChatProviderError();
      const store = await sqliteStore();
      const normalized = sqliteUuid(id);
      const scope = `refresh:${normalized}`;
      const claim = crypto.randomUUID();
      const saved = store.transaction(executor => {
        const current = googleProfile(executor, normalized);
        const baseline = JSON.stringify(current.credential);
        const pending = executor.get<{ payload: string }>("SELECT payload FROM ai_auth_attempts WHERE scope_key=?", [scope]);
        if (pending?.payload === baseline) throw new ChatProviderError();
        executor.run("DELETE FROM ai_auth_attempts WHERE scope_key=?", [scope]);
        executor.run(
          `INSERT INTO ai_auth_attempts(id,provider,scope_key,browser_hash,status,payload,expires_at)
           VALUES (?,'google',?,'internal-refresh','starting',?,?)`,
          [claim, scope, baseline, sqliteTimestamp("9999-12-31T23:59:59Z")],
        );
        return current;
      });
      let baseline = JSON.stringify(saved.credential);
      let readback = false;
      let provider: ChatProvider;
      try {
        provider = createCliProvider({ provider: "google", model: saved.connection.model }, {
        ...options,
        session: {
          credential: saved.credential,
          persist: async credential => {
            store.transaction(executor => {
              const reservation = executor.get<{ payload: string }>(
                "SELECT payload FROM ai_auth_attempts WHERE id=? AND scope_key=?", [claim, scope],
              );
              if (!reservation || reservation.payload !== baseline) return;
              // Deletion/reconnect invalidates old writeback; never recreate it.
              const row = executor.get<{ connection: string }>("SELECT connection FROM ai_connections WHERE id=?", [normalized]);
              if (!row) return;
              const current = googleProfile(executor, normalized);
              if (JSON.stringify(current.credential) !== baseline) return;
              executor.run("UPDATE ai_connections SET connection=?,updated_at=? WHERE id=?",
                [JSON.stringify({ ...current.connection, credential }), sqliteTimestamp(new Date()), normalized]);
              baseline = JSON.stringify(credential);
              executor.run("UPDATE ai_auth_attempts SET payload=? WHERE id=?", [baseline, claim]);
            });
            readback = true;
          },
        },
        });
      } catch (error) {
        store.run("DELETE FROM ai_auth_attempts WHERE id=?", [claim]);
        throw error;
      }
      try {
        const text = await provider.stream(input, onDelta, signal);
        readback = true;
        return text;
      } finally {
        // A valid readback remains committed even when generation failed.
        // Corrupt/missing/ambiguous readback keeps the reservation for reconnect.
        if (readback) store.run("DELETE FROM ai_auth_attempts WHERE id=?", [claim]);
      }
    },
  };
}
