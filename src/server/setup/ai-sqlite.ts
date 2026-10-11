import {
  AI_PROVIDERS, JEV_PROVIDERS, AiSettingsDocumentSchema, ConnectionProfileInputSchema,
  ConnectionProfileSchema, type AiSettingsDocument, type AiSettingsInput,
  type ConnectionProfile, type ConnectionProfileInput,
} from "@/lib/ai-settings";
import { consumeSQLiteAuthAttempt, type AiAuthScope } from "@/server/ai-auth/attempt-store";
import type { SQLiteExecutor } from "@/server/db/sqlite";
import { sqliteTimestamp, sqliteUuid } from "@/server/db/sqlite/values";
import { ApiError } from "@/server/http";
import { setupCopy } from "@/server/i18n/setup-copy";
import { legacyJevConnection } from "./ai-legacy";
import { resolvedChatConnection, resolvedStoredJevConnection } from "./ai-profile-resolve";

export function sqliteSettingsOwner(executor: SQLiteExecutor): string {
  const owner = executor.get<{ id: string }>("SELECT id FROM users ORDER BY created_at,id LIMIT 1");
  if (!owner) throw new ApiError("conflict", setupCopy.setupFirst);
  return owner.id;
}

export function sqliteSettingsDocument(executor: SQLiteExecutor): AiSettingsDocument | null {
  const row = executor.get<{ ai: string }>("SELECT ai FROM installation_settings WHERE singleton=1");
  return row ? AiSettingsDocumentSchema.parse(JSON.parse(row.ai)) : null;
}

export function sqliteConnectionProfiles(executor: SQLiteExecutor, ownerId: string): ConnectionProfile[] {
  return executor.all<{ id: string; name: string; purpose: string; connection: string }>(
    "SELECT id,name,purpose,connection FROM ai_connections WHERE owner_id=? ORDER BY created_at,id",
    [sqliteUuid(ownerId)],
  ).map(row => ConnectionProfileSchema.parse({ ...row, connection: JSON.parse(row.connection) }));
}

export function writeSQLiteConnectionProfile(
  executor: SQLiteExecutor,
  input: ConnectionProfileInput,
  options: { readonly ownerId: string; readonly scope: AiAuthScope; readonly previous?: ConnectionProfile },
): ConnectionProfile {
  ConnectionProfileInputSchema.parse(input);
  const previous = options.previous;
  if (previous && previous.purpose !== input.purpose) throw new ApiError("validation", setupCopy.purposeLocked);
  if (!previous) {
    const count = executor.get<{ count: bigint }>(
      "SELECT count(*) AS count FROM ai_connections WHERE owner_id=?", [sqliteUuid(options.ownerId)],
    );
    if ((count?.count ?? 0n) >= 40n) throw new ApiError("validation", setupCopy.limit);
  }
  const auth = input.connection.mode === "auth" ? input.connection : null;
  const granted = auth?.authAttemptId ? consumeSQLiteAuthAttempt(executor, {
    id: auth.authAttemptId, provider: auth.provider, scope: options.scope,
  }) : undefined;
  const connection = input.purpose === "chat"
    ? resolvedChatConnection(input.connection, previous?.purpose === "chat" ? previous.connection : null, granted)
    : resolvedStoredJevConnection(input.connection, previous?.purpose === "jev" ? previous.connection : null, granted);
  const profile = ConnectionProfileSchema.parse({
    id: previous?.id ?? crypto.randomUUID(), name: input.name, purpose: input.purpose, connection,
  });
  const now = sqliteTimestamp(new Date());
  executor.run(
    `INSERT INTO ai_connections(id,owner_id,purpose,name,connection,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name,connection=excluded.connection,updated_at=excluded.updated_at`,
    [profile.id, sqliteUuid(options.ownerId), profile.purpose, profile.name, JSON.stringify(connection), now, now],
  );
  const oldCredential = previous?.connection.mode === "auth" ? previous.connection.credential : undefined;
  const nextCredential = connection.mode === "auth" ? connection.credential : undefined;
  if (previous && JSON.stringify(oldCredential) !== JSON.stringify(nextCredential)) {
    executor.run("DELETE FROM ai_auth_attempts WHERE scope_key=?", [`refresh:${profile.id}`]);
  }
  return profile;
}

export function resolveSQLiteAiSettings(
  executor: SQLiteExecutor,
  input: AiSettingsInput,
  context: { readonly ownerId: string; readonly previous: AiSettingsDocument | null; readonly scope: AiAuthScope },
): AiSettingsDocument {
  if ((input.chat && !input.chatConsent) || (input.jev && !input.jevConsent)) {
    throw new ApiError("validation", setupCopy.consent);
  }
  const profiles = sqliteConnectionProfiles(executor, context.ownerId);
  let chatId: string | null = null;
  if (input.chat) {
    switch (input.chat.mode) {
      case "saved": {
        const id = sqliteUuid(input.chat.id);
        if (!profiles.some(p => p.id === id && p.purpose === "chat")) {
          throw new ApiError("validation", setupCopy.purposeMismatch);
        }
        chatId = id;
        break;
      }
      case "environment":
        chatId = "environment";
        break;
      case "api":
      case "auth": {
        const previous = profiles.find(p => p.id === context.previous?.chatId && p.purpose === "chat");
        const providerId = input.chat.provider;
        const provider = AI_PROVIDERS.find(p => p.id === providerId);
        chatId = writeSQLiteConnectionProfile(executor, {
          purpose: "chat", name: input.chatName ?? previous?.name ?? provider?.name ?? input.chat.provider,
          connection: input.chat, consent: true,
        }, { ...context, previous }).id;
        break;
      }
      default: {
        const exhaustive: never = input.chat;
        return exhaustive;
      }
    }
  }
  let jevId: string | null = null;
  if (input.jev) {
    switch (input.jev.mode) {
      case "saved": {
        const id = sqliteUuid(input.jev.id);
        if (!profiles.some(p => p.id === id && p.purpose === "jev")) {
          throw new ApiError("validation", setupCopy.purposeMismatch);
        }
        jevId = id;
        break;
      }
      case "environment":
        jevId = "environment";
        break;
      case undefined:
      case "api":
      case "auth": {
        const previous = profiles.find(p => p.id === context.previous?.jevId && p.purpose === "jev");
        const legacy = context.previous === null || context.previous.jevId === "environment" ? legacyJevConnection() : null;
        const connection = input.jev.mode !== "auth" && input.jev.apiKey === undefined && legacy?.provider === input.jev.provider
          ? { ...input.jev, apiKey: legacy.apiKey } : input.jev;
        const provider = JEV_PROVIDERS.find(p => p.id === connection.provider);
        jevId = writeSQLiteConnectionProfile(executor, {
          purpose: "jev", name: input.jevName ?? previous?.name ?? provider?.name ?? connection.provider,
          connection, consent: true,
        }, { ...context, previous }).id;
        break;
      }
      default: {
        const exhaustive: never = input.jev;
        return exhaustive;
      }
    }
  }
  return { version: 2, chatId, jevId };
}

export function persistSQLiteAiSettings(
  executor: SQLiteExecutor, ownerId: string, ai: AiSettingsDocument,
): void {
  executor.run(
    `INSERT INTO installation_settings(singleton,owner_id,ai,updated_at) VALUES (1,?,?,?)
     ON CONFLICT(singleton) DO UPDATE SET ai=excluded.ai,updated_at=excluded.updated_at`,
    [sqliteUuid(ownerId), JSON.stringify(ai), sqliteTimestamp(new Date())],
  );
}
