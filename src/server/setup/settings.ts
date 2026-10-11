import { setupCopy } from "@/server/i18n/setup-copy";
import type { AiSettingsInput, AiSettingsView, StoredAiSettings } from "@/lib/ai-settings";
import { tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { legacyChatConnection, legacyJevConnection } from "./ai-legacy";
import {
  AI_SETTINGS_LOCK, connectionProfiles, profileView, settingsDocument, settingsOwner,
} from "./ai-profile-store";
import { resolvedJevConnection } from "./ai-profile-resolve";
import { resolveAiSettings } from "./ai-settings-resolve";
import { persistSQLiteAiSettings, resolveSQLiteAiSettings, sqliteSettingsDocument, sqliteSettingsOwner } from "./ai-sqlite";

export { resolveAiSettings } from "./ai-settings-resolve";

/** Resolve active profiles; inactive secrets never become active implicitly. */
export async function storedAiSettings(): Promise<StoredAiSettings | null> {
  const saved = await settingsDocument();
  if (!saved) return null;
  const ownerId = await settingsOwner();
  if (!ownerId) throw new ApiError("conflict", setupCopy.setupFirst);
  const profiles = await connectionProfiles(ownerId);
  const chat = profiles.find((profile) => profile.id === saved.chatId && profile.purpose === "chat");
  const jev = profiles.find((profile) => profile.id === saved.jevId && profile.purpose === "jev");
  return {
    chat: saved.chatId === "environment" ? await legacyChatConnection()
      : chat?.purpose === "chat" ? chat.connection : null,
    jev: saved.jevId === "environment" ? legacyJevConnection()
      : jev?.purpose === "jev" ? resolvedJevConnection(jev.connection) : null,
  };
}

export async function aiSettingsView(): Promise<AiSettingsView> {
  const saved = await settingsDocument();
  const ownerId = await settingsOwner();
  const profiles = ownerId ? (await connectionProfiles(ownerId)).map(profileView) : [];
  const chatId = saved?.chatId ?? (saved === null ? "environment" : null);
  const jevId = saved?.jevId ?? (saved === null ? "environment" : null);
  const chat = profiles.find((profile) => profile.id === chatId && profile.purpose === "chat");
  const jev = profiles.find((profile) => profile.id === jevId && profile.purpose === "jev");
  const legacyChat = chatId === "environment" ? await legacyChatConnection() : null;
  const legacyJev = jevId === "environment" ? legacyJevConnection() : null;
  return {
    chat: chat?.purpose === "chat" ? chat.connection : legacyChat ? {
      provider: legacyChat.provider, mode: legacyChat.mode, model: legacyChat.model, hasApiKey: false,
    } : null,
    jev: jev?.purpose === "jev" ? jev.connection : legacyJev ? {
      provider: legacyJev.provider, model: legacyJev.model, hasApiKey: true,
    } : null,
    profiles,
    chatId,
    jevId,
    jevManagedByEnvironment: jevId === "environment" && Boolean(process.env.TYPESAFE_API_KEY?.trim()),
    chatManagedByEnvironment: legacyChat !== null,
  };
}

export async function saveAiSettings(
  input: AiSettingsInput,
  options: { readonly browserHash?: string } = {},
): Promise<void> {
  if (databaseBackend() === "sqlite") {
    (await sqliteStore()).transaction(executor => {
      const ownerId = sqliteSettingsOwner(executor);
      const ai = resolveSQLiteAiSettings(executor, input, {
        ownerId, previous: sqliteSettingsDocument(executor),
        scope: { key: `owner:${ownerId}`, browserHash: options.browserHash },
      });
      persistSQLiteAiSettings(executor, ownerId, ai);
    });
    return;
  }
  await tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [AI_SETTINGS_LOCK]);
    const ownerId = await settingsOwner(client);
    if (!ownerId) throw new ApiError("conflict", setupCopy.setupFirst);
    const ai = await resolveAiSettings(client, input, {
      ownerId,
      previous: await settingsDocument(client),
      scope: { key: `owner:${ownerId}`, browserHash: options.browserHash },
    });
    await client.query(
      `INSERT INTO installation_settings (singleton, owner_id, ai) VALUES (true, $1, $2::jsonb)
       ON CONFLICT (singleton) DO UPDATE SET ai = EXCLUDED.ai, updated_at = now()`,
      [ownerId, JSON.stringify(ai)],
    );
  });
}
