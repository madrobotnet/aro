import { aiAuthCopy } from "@/server/i18n/ai-auth-copy";
import type { AuthProtocolOptions } from "@/lib/ai-auth";
import { tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { saveSQLiteAuthAttempt, sqliteAuthAttempt } from "./sqlite-store";
import { pollSQLiteAuthAttempt } from "./sqlite-exchange";
import { ApiError } from "@/server/http";
import { lockedAuthAttempt, PkcePayloadSchema } from "./attempt-data";
import { exchangeOpenRouterAttempt } from "./openrouter-attempt";

export async function finishOpenRouterAuth(
  input: { readonly id: string; readonly code?: string; readonly denied?: boolean; readonly browserHash?: string },
  options: AuthProtocolOptions = {},
): Promise<{ readonly success: boolean; readonly setup: boolean; readonly pending?: boolean }> {
  if (databaseBackend() === "sqlite") {
    const result = (await sqliteStore()).transaction(executor => {
      const attempt = sqliteAuthAttempt(executor, input.id);
      if (!input.browserHash || input.browserHash !== attempt.browser_hash || attempt.provider !== "openrouter") {
        throw new ApiError("forbidden", aiAuthCopy.wrongBrowser);
      }
      if (attempt.status !== "pending") throw new ApiError("conflict", aiAuthCopy.alreadyHandled);
      const payload = PkcePayloadSchema.parse(attempt.payload);
      if (payload.code) throw new ApiError("conflict", aiAuthCopy.alreadyHandled);
      const setup = attempt.scope_key.startsWith("setup:");
      if (input.denied || attempt.expires_at.getTime() <= (options.now ?? Date.now)()) {
        saveSQLiteAuthAttempt(executor, { ...attempt, status: "denied", payload: {} });
        return { setup, scope: null };
      }
      if (!input.code || input.code.length > 4096) throw new ApiError("validation", aiAuthCopy.callbackNoCode);
      saveSQLiteAuthAttempt(executor, { ...attempt, payload: { ...payload, code: input.code }, next_poll_at: null });
      return { setup, scope: { key: attempt.scope_key, browserHash: attempt.browser_hash } };
    });
    if (!result.scope) return { success: false, setup: result.setup };
    const completed = await pollSQLiteAuthAttempt(input.id, result.scope, options);
    return { success: completed.status === "ready", setup: result.setup,
      ...(completed.status === "pending" ? { pending: true } : {}) };
  }
  return tx(async (client) => {
    const attempt = await lockedAuthAttempt(client, input.id);
    if (!input.browserHash || input.browserHash !== attempt.browser_hash || attempt.provider !== "openrouter") {
      throw new ApiError("forbidden", aiAuthCopy.wrongBrowser);
    }
    if (attempt.status !== "pending") throw new ApiError("conflict", aiAuthCopy.alreadyHandled);
    const payload = PkcePayloadSchema.parse(attempt.payload);
    if (payload.code) throw new ApiError("conflict", aiAuthCopy.alreadyHandled);
    const setup = attempt.scope_key.startsWith("setup:");
    if (input.denied || attempt.expires_at.getTime() <= (options.now ?? Date.now)()) {
      await client.query("UPDATE ai_auth_attempts SET status = 'denied', payload = '{}'::jsonb WHERE id = $1", [input.id]);
      return { success: false, setup };
    }
    if (!input.code || input.code.length > 4096) throw new ApiError("validation", aiAuthCopy.callbackNoCode);
    const result = await exchangeOpenRouterAttempt(client, {
      ...attempt, payload: { ...payload, code: input.code },
    }, options);
    return {
      success: result.status === "ready", setup,
      ...(result.status === "pending" ? { pending: true } : {}),
    };
  });
}
