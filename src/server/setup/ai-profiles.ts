import { setupCopy } from "@/server/i18n/setup-copy";
import type { PoolClient } from "pg";
import {
  ConnectionProfileSchema, type ConnectionProfile, type ConnectionProfileInput,
} from "@/lib/ai-settings";
import type { AiAuthScope } from "@/server/ai-auth/attempt-store";
import { tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { sqliteUuid } from "@/server/db/sqlite/values";
import {
  persistSQLiteAiSettings, sqliteConnectionProfiles, sqliteSettingsDocument,
  sqliteSettingsOwner, writeSQLiteConnectionProfile,
} from "./ai-sqlite";
import { ApiError } from "@/server/http";
import { AI_SETTINGS_LOCK, connectionProfiles, settingsDocument, settingsOwner } from "./ai-profile-store";
import { resolveChatConnection, resolveJevConnection } from "./ai-profile-resolve";

export async function writeConnectionProfile(
  client: PoolClient,
  input: ConnectionProfileInput,
  options: { readonly ownerId: string; readonly scope: AiAuthScope; readonly previous?: ConnectionProfile },
): Promise<ConnectionProfile> {
  const previous = options.previous;
  if (previous && previous.purpose !== input.purpose) {
    throw new ApiError("validation", setupCopy.purposeLocked);
  }
  if (!previous) {
    const count = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM ai_connections WHERE owner_id = $1",
      [options.ownerId],
    );
    if ((count.rows[0]?.count ?? 0) >= 40) throw new ApiError("validation", setupCopy.limit);
  }
  const context = { client, scope: options.scope };
  let connection;
  switch (input.purpose) {
    case "chat":
      connection = await resolveChatConnection(input.connection, previous?.purpose === "chat" ? previous.connection : null, context);
      break;
    case "jev":
      connection = await resolveJevConnection(input.connection, previous?.purpose === "jev" ? previous.connection : null, context);
      break;
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
  const id = previous?.id ?? crypto.randomUUID();
  await client.query(
    `INSERT INTO ai_connections (id, owner_id, purpose, name, connection) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, connection = EXCLUDED.connection, updated_at = now()`,
    [id, options.ownerId, input.purpose, input.name, JSON.stringify(connection)],
  );
  return ConnectionProfileSchema.parse({ id, name: input.name, purpose: input.purpose, connection });
}

export async function saveConnectionProfile(
  input: ConnectionProfileInput,
  options: { readonly id?: string; readonly browserHash?: string } = {},
): Promise<ConnectionProfile> {
  if (databaseBackend() === "sqlite") {
    return (await sqliteStore()).transaction(executor => {
      const ownerId = sqliteSettingsOwner(executor);
      const profiles = sqliteConnectionProfiles(executor, ownerId);
      const id = options.id ? sqliteUuid(options.id) : undefined;
      const previous = id ? profiles.find(profile => profile.id === id) : undefined;
      if (options.id && !previous) throw new ApiError("not_found", setupCopy.notFound);
      return writeSQLiteConnectionProfile(executor, input, {
        ownerId, previous, scope: { key: `owner:${ownerId}`, browserHash: options.browserHash },
      });
    });
  }
  return tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [AI_SETTINGS_LOCK]);
    const ownerId = await settingsOwner(client);
    if (!ownerId) throw new ApiError("conflict", setupCopy.setupFirst);
    const profiles = await connectionProfiles(ownerId, client);
    const previous = options.id ? profiles.find((profile) => profile.id === options.id) : undefined;
    if (options.id && !previous) throw new ApiError("not_found", setupCopy.notFound);
    return writeConnectionProfile(client, input, {
      ownerId, previous, scope: { key: `owner:${ownerId}`, browserHash: options.browserHash },
    });
  });
}

export async function deleteConnectionProfile(id: string): Promise<void> {
  if (databaseBackend() === "sqlite") {
    (await sqliteStore()).transaction(executor => {
      const ownerId = sqliteSettingsOwner(executor);
      const normalized = sqliteUuid(id);
      const removed = executor.run("DELETE FROM ai_connections WHERE id=? AND owner_id=?", [normalized, ownerId]);
      if (!removed.changes) throw new ApiError("not_found", setupCopy.notFound);
      executor.run("DELETE FROM ai_auth_attempts WHERE scope_key=?", [`refresh:${normalized}`]);
      const saved = sqliteSettingsDocument(executor);
      if (saved && (saved.chatId === normalized || saved.jevId === normalized)) {
        persistSQLiteAiSettings(executor, ownerId, {
          ...saved, chatId: saved.chatId === normalized ? null : saved.chatId,
          jevId: saved.jevId === normalized ? null : saved.jevId,
        });
      }
    });
    return;
  }
  await tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [AI_SETTINGS_LOCK]);
    const ownerId = await settingsOwner(client);
    if (!ownerId) throw new ApiError("conflict", setupCopy.setupFirst);
    const removed = await client.query("DELETE FROM ai_connections WHERE id = $1 AND owner_id = $2 RETURNING id", [id, ownerId]);
    if (!removed.rowCount) throw new ApiError("not_found", setupCopy.notFound);
    const saved = await settingsDocument(client);
    if (saved && (saved.chatId === id || saved.jevId === id)) {
      const updated = { ...saved, chatId: saved.chatId === id ? null : saved.chatId, jevId: saved.jevId === id ? null : saved.jevId };
      await client.query("UPDATE installation_settings SET ai = $1::jsonb, updated_at = now() WHERE singleton", [JSON.stringify(updated)]);
    }
  });
}
