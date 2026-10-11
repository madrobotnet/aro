import { ConnectionProfileSchema } from "@/lib/ai-settings";
import { createCliProvider, type CliProviderOptions } from "@/server/chat/cli-provider";
import { ChatProviderError, type ChatProvider } from "@/server/chat/provider";
import { tx } from "@/server/db";
import { databaseBackend } from "@/server/db/backend";
import { createSQLiteGoogleProfileProvider } from "./sqlite-google-profile";

/** The row lock serializes CLI refreshes across processes, with profile edits and
 * deletion. No global settings lock is held during generation; unrelated profiles
 * can run independently. A failed chat still commits any valid refreshed tokens. */
export function createGoogleProfileProvider(id: string, options: Omit<CliProviderOptions, "session"> = {}): ChatProvider {
  if (databaseBackend() === "sqlite") return createSQLiteGoogleProfileProvider(id, options);
  return {
    async stream(input, onDelta, signal) {
      const result = await tx(async (client) => {
        const { rows: [row] } = await client.query<{ id: string; name: string; purpose: string; connection: unknown }>(
          `SELECT id, name, purpose, connection FROM ai_connections
           WHERE id = $1 AND owner_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) FOR UPDATE`, [id],
        );
        if (!row) throw new ChatProviderError();
        const profile = ConnectionProfileSchema.parse(row);
        const connection = profile.connection;
        if (profile.purpose !== "chat" || connection.mode !== "auth" || connection.provider !== "google"
          || connection.credential?.provider !== "google") throw new ChatProviderError();
        const provider = createCliProvider({ provider: "google", model: connection.model }, {
          ...options,
          session: {
            credential: connection.credential,
            persist: async (credential) => {
              await client.query("UPDATE ai_connections SET connection = $2::jsonb, updated_at = now() WHERE id = $1",
                [id, JSON.stringify({ ...connection, credential })]);
            },
          },
        });
        try {
          return { ok: true as const, text: await provider.stream(input, onDelta, signal) };
        } catch (error) {
          if (!(error instanceof ChatProviderError)) throw error;
          return { ok: false as const, error };
        }
      });
      if (!result.ok) throw result.error;
      return result.text;
    },
  };
}
