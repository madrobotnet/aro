import { setupCopy } from "@/server/i18n/setup-copy";
import type { PoolClient } from "pg";
import {
  AiSettingsDocumentSchema, ConnectionProfileSchema,
  type AiSettingsDocument, type ConnectionProfile, type ConnectionProfileView,
} from "@/lib/ai-settings";
import type { ConnectionPurpose } from "@/lib/ai-providers";
import { query, queryOne } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { ApiError } from "@/server/http";

export const AI_SETTINGS_LOCK = 7_431_003;
type ProfileRow = { id: string; name: string; purpose: string; connection: unknown };

export async function settingsOwner(client?: PoolClient): Promise<string | null> {
  const sql = "SELECT id FROM users ORDER BY created_at, id LIMIT 1";
  if (!client && databaseBackend() === "sqlite") {
    return (await sqliteStore()).get<{ id: string }>(sql)?.id ?? null;
  }
  const row = client
    ? (await client.query<{ id: string }>(sql)).rows[0]
    : await queryOne<{ id: string }>(sql);
  return row?.id ?? null;
}

export async function settingsDocument(client?: PoolClient): Promise<AiSettingsDocument | null> {
  const sql = "SELECT ai FROM installation_settings WHERE singleton";
  if (!client && databaseBackend() === "sqlite") {
    const row = (await sqliteStore()).get<{ ai: string }>(sql);
    return row ? AiSettingsDocumentSchema.parse(JSON.parse(row.ai)) : null;
  }
  const row = client
    ? (await client.query<{ ai: unknown }>(sql)).rows[0]
    : await queryOne<{ ai: unknown }>(sql);
  return row ? AiSettingsDocumentSchema.parse(row.ai) : null;
}

export async function connectionProfiles(ownerId: string, client?: PoolClient): Promise<ConnectionProfile[]> {
  if (!client && databaseBackend() === "sqlite") {
    const rows = (await sqliteStore()).all<{ id: string; name: string; purpose: string; connection: string }>(
      "SELECT id,name,purpose,connection FROM ai_connections WHERE owner_id=? ORDER BY created_at,id", [ownerId.toLowerCase()],
    );
    return rows.map(row => ConnectionProfileSchema.parse({ ...row, connection: JSON.parse(row.connection) }));
  }
  const sql = "SELECT id, name, purpose, connection FROM ai_connections WHERE owner_id = $1 ORDER BY created_at, id";
  const rows = client
    ? (await client.query<ProfileRow>(sql, [ownerId])).rows
    : await query<ProfileRow>(sql, [ownerId]);
  return rows.map((row) => ConnectionProfileSchema.parse(row));
}

export function profileView(profile: ConnectionProfile): ConnectionProfileView {
  switch (profile.purpose) {
    case "chat": {
      const connection = profile.connection;
      return {
        id: profile.id, name: profile.name, purpose: "chat",
        connection: {
          provider: connection.provider, mode: connection.mode, model: connection.model,
          hasApiKey: connection.mode === "api" && connection.apiKey.length > 0,
          ...(connection.mode === "api" ? {
            baseUrl: connection.baseUrl, apiFormat: connection.apiFormat,
            maxOutputTokens: connection.maxOutputTokens, headerNames: Object.keys(connection.headers ?? {}),
          } : {
            hasCredential: connection.credential !== undefined,
            apiFormat: connection.apiFormat, enterpriseDomain: connection.enterpriseDomain,
          }),
        },
      };
    }
    case "jev": {
      const connection = profile.connection;
      return {
        id: profile.id, name: profile.name, purpose: "jev",
        connection: {
          provider: connection.provider, mode: connection.mode ?? "api", model: connection.model,
          hasApiKey: connection.mode !== "auth",
          ...(connection.mode === "auth" ? { hasCredential: connection.credential !== undefined } : {}),
        },
      };
    }
    default: {
      const exhaustive: never = profile;
      return exhaustive;
    }
  }
}

export type AiSelection =
  | { readonly source: "environment" }
  | { readonly source: "disabled" }
  | { readonly source: "profile"; readonly profile: ConnectionProfile };

export async function aiSelection(purpose: ConnectionPurpose): Promise<AiSelection> {
  const saved = await settingsDocument();
  const id = saved === null ? "environment" : purpose === "chat" ? saved.chatId : saved.jevId;
  if (id === "environment") return { source: "environment" };
  if (id === null) return { source: "disabled" };
  const ownerId = await settingsOwner();
  if (!ownerId) throw new ApiError("conflict", setupCopy.setupFirst);
  const profiles = await connectionProfiles(ownerId);
  const profile = profiles.find((entry) => entry.id === id && entry.purpose === purpose);
  if (!profile) throw new ApiError("conflict", setupCopy.selectedMissing);
  return { source: "profile", profile };
}
