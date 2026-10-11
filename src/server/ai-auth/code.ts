import { aiAuthCopy } from "@/server/i18n/ai-auth-copy";
import { AuthCodeInputSchema, type AuthAttemptView } from "@/lib/ai-auth-flow";
import type { AuthProtocolOptions } from "@/lib/ai-auth";
import { tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { saveSQLiteAuthAttempt, sqliteAuthAttempt } from "./sqlite-store";
import { pollSQLiteAuthAttempt } from "./sqlite-exchange";
import { ApiError } from "@/server/http";
import type { AiAuthScope } from "./attempt-store";
import { authAttemptView, lockedAuthAttempt, PkcePayloadSchema, requireAttemptScope } from "./attempt-data";
import { completeCodeExchange, prepareCodeExchange } from "./code-attempt";

export async function submitAuthCode(
  input: { readonly id: string; readonly code: string }, scope: AiAuthScope, options: AuthProtocolOptions = {},
): Promise<AuthAttemptView> {
  const { code } = AuthCodeInputSchema.parse({ code: input.code });
  if (databaseBackend() === "sqlite") {
    const result = (await sqliteStore()).transaction(executor => {
      const attempt = sqliteAuthAttempt(executor, input.id);
      requireAttemptScope(attempt, scope);
      if (attempt.provider !== "google") throw new ApiError("validation", aiAuthCopy.codeUnsupported);
      const now = (options.now ?? Date.now)();
      if (attempt.expires_at.getTime() <= now) {
        const expired = { ...attempt, status: "expired" as const, payload: {} };
        saveSQLiteAuthAttempt(executor, expired);
        return authAttemptView(expired, now);
      }
      if (attempt.status !== "pending") return authAttemptView(attempt, now);
      const payload = PkcePayloadSchema.parse(attempt.payload);
      if (payload.code) throw new ApiError("conflict", aiAuthCopy.codePending);
      saveSQLiteAuthAttempt(executor, { ...attempt, payload: { ...payload, code }, next_poll_at: null });
      return null;
    });
    return result ?? pollSQLiteAuthAttempt(input.id, scope, options);
  }
  const result = await tx(async (client) => {
    const attempt = await lockedAuthAttempt(client, input.id);
    requireAttemptScope(attempt, scope);
    if (attempt.provider !== "google") throw new ApiError("validation", aiAuthCopy.codeUnsupported);
    const now = (options.now ?? Date.now)();
    if (attempt.expires_at.getTime() <= now) {
      await client.query("UPDATE ai_auth_attempts SET status = 'expired', payload = '{}'::jsonb WHERE id = $1", [attempt.id]);
      return authAttemptView({ ...attempt, status: "expired", payload: {} }, now);
    }
    // A late duplicate submit must not overwrite an already-ready credential.
    if (attempt.status !== "pending") return authAttemptView(attempt, now);
    const payload = PkcePayloadSchema.parse(attempt.payload);
    if (payload.code) throw new ApiError("conflict", aiAuthCopy.codePending);
    return prepareCodeExchange(client, { ...attempt, payload: { ...payload, code } }, options);
  });
  return "attempt" in result ? completeCodeExchange(result, options) : result;
}
