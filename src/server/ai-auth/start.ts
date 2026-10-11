import { aiAuthCopy } from "@/server/i18n/ai-auth-copy";
import type { AuthProtocolOptions } from "@/lib/ai-auth";
import type { AuthAttemptView, AuthStartInput } from "@/lib/ai-auth-flow";
import { query, tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { sqliteTimestamp } from "@/server/db/sqlite/values";
import { sqliteAuthAttempt, saveSQLiteAuthAttempt } from "./sqlite-store";
import { ApiError } from "@/server/http";
import { AI_SETTINGS_LOCK } from "@/server/setup/ai-profile-store";
import type { AiAuthScope } from "./attempt-store";
import { authAttemptView, DevicePayloadSchema, PkcePayloadSchema, type AuthAttemptRow } from "./attempt-data";
import { createPkce, openRouterAuthorizationUrl, startDeviceAuthorization } from "./protocol";
import { googleAuthorizationUrl } from "./google";
import { startOpenAiDeviceAuthorization } from "./openai";

export async function startAuthAttempt(
  input: AuthStartInput & { readonly callbackOrigin: string },
  scope: AiAuthScope,
  options: AuthProtocolOptions = {},
): Promise<AuthAttemptView> {
  if (!scope.browserHash) throw new ApiError("forbidden", aiAuthCopy.browserUnknown);
  const now = (options.now ?? Date.now)();
  const id = crypto.randomUUID();
  const expiresAt = new Date(now + 15 * 60_000);
  const sqlite = databaseBackend() === "sqlite" ? await sqliteStore() : null;
  if (sqlite) {
    sqlite.transaction(executor => {
      executor.run("DELETE FROM ai_auth_attempts WHERE expires_at<=?", [sqliteTimestamp(new Date(now))]);
      const count = executor.get<{ count: bigint }>(
        "SELECT count(*) AS count FROM ai_auth_attempts WHERE scope_key=? AND status IN ('starting','pending','ready')",
        [scope.key],
      );
      if ((count?.count ?? 0n) >= 8n) throw new ApiError("rate_limited", aiAuthCopy.tooManyPending);
      executor.run(
        `INSERT INTO ai_auth_attempts(id,provider,scope_key,browser_hash,status,payload,expires_at)
         VALUES (?,?,?,?,'starting','{}',?)`,
        [id, input.provider, scope.key, scope.browserHash ?? "", sqliteTimestamp(expiresAt)],
      );
    });
  } else await tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [AI_SETTINGS_LOCK]);
    await client.query("DELETE FROM ai_auth_attempts WHERE expires_at <= $1", [new Date(now)]);
    const count = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ai_auth_attempts
       WHERE scope_key = $1 AND status IN ('starting', 'pending', 'ready')`,
      [scope.key],
    );
    if ((count.rows[0]?.count ?? 0) >= 8) throw new ApiError("rate_limited", aiAuthCopy.tooManyPending);
    await client.query(
      `INSERT INTO ai_auth_attempts (id, provider, scope_key, browser_hash, status, payload, expires_at)
       VALUES ($1, $2, $3, $4, 'starting', '{}'::jsonb, $5)`,
      [id, input.provider, scope.key, scope.browserHash, expiresAt],
    );
  });
  try {
    let payload;
    let nextPollAt: Date | null = null;
    let expiry = expiresAt;
    switch (input.provider) {
      case "openrouter": {
        const { verifier, challenge } = await createPkce();
        const callbackUrl = new URL(`/api/ai/auth/openrouter/callback/${id}`, input.callbackOrigin).href;
        payload = PkcePayloadSchema.parse({
          kind: "pkce", verifier,
          verificationUrl: openRouterAuthorizationUrl({ callbackUrl, challenge }),
        });
        break;
      }
      case "google": {
        const { verifier, challenge } = await createPkce();
        payload = PkcePayloadSchema.parse({ kind: "pkce", verifier, verificationUrl: googleAuthorizationUrl(challenge) });
        break;
      }
      case "github-copilot":
      case "openai":
      case "xai": {
        const device = input.provider === "openai" ? await startOpenAiDeviceAuthorization(options)
          : await startDeviceAuthorization(input.provider, {
            ...options, enterpriseDomain: input.enterpriseDomain,
          });
        const { expiresAt: deviceExpiry, ...devicePayload } = device;
        payload = DevicePayloadSchema.parse({ kind: "device", ...devicePayload, enterpriseDomain: input.enterpriseDomain });
        expiry = new Date(Math.min(deviceExpiry, expiresAt.getTime()));
        nextPollAt = new Date(now + device.intervalSeconds * 1000);
        break;
      }
      default: {
        const exhaustive: never = input.provider;
        return exhaustive;
      }
    }
    if (sqlite) {
      return sqlite.transaction(executor => {
        const attempt = sqliteAuthAttempt(executor, id);
        if (attempt.status !== "starting" || attempt.scope_key !== scope.key
          || attempt.browser_hash !== scope.browserHash || attempt.expires_at.getTime() <= (options.now ?? Date.now)()) {
          throw new ApiError("conflict", aiAuthCopy.startCanceled);
        }
        const updated = { ...attempt, status: "pending" as const, payload, expires_at: expiry, next_poll_at: nextPollAt };
        saveSQLiteAuthAttempt(executor, updated);
        return authAttemptView(updated, now);
      });
    }
    const rows = await query<AuthAttemptRow>(
      `UPDATE ai_auth_attempts SET status = 'pending', payload = $2::jsonb, expires_at = $3, next_poll_at = $4
       WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(payload), expiry, nextPollAt],
    );
    const attempt = rows[0];
    if (!attempt) throw new ApiError("conflict", aiAuthCopy.startCanceled);
    return authAttemptView(attempt, now);
  } catch (error) {
    if (sqlite) sqlite.run("DELETE FROM ai_auth_attempts WHERE id=?", [id]);
    else await query("DELETE FROM ai_auth_attempts WHERE id = $1", [id]);
    if (error instanceof ApiError) throw error;
    throw new ApiError("upstream_failed", aiAuthCopy.startFailed);
  }
}
