import { OAuthCredentialSchema, type AuthProtocolOptions, type OAuthCredential, type DevicePollResult } from "@/lib/ai-auth";
import type { AuthAttemptView } from "@/lib/ai-auth-flow";
import { sqliteStore } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { aiAuthCopy } from "@/server/i18n/ai-auth-copy";
import { authAttemptView, DevicePayloadSchema, PkcePayloadSchema, requireAttemptScope, type AuthAttemptRow } from "./attempt-data";
import type { AiAuthScope } from "./attempt-store";
import { exchangeGoogleCode } from "./google";
import { exchangeOpenAiCode, pollOpenAiDeviceAuthorization } from "./openai";
import { exchangeOpenRouterCode, OAuthProtocolError, pollDeviceAuthorization } from "./protocol";
import { saveSQLiteAuthAttempt, sqliteAuthAttempt } from "./sqlite-store";

type Payload = ReturnType<typeof DevicePayloadSchema.parse> | ReturnType<typeof PkcePayloadSchema.parse>;
type Claim = { readonly attempt: AuthAttemptRow; readonly payload: Payload };

/** A persisted claim excludes other workers before any provider work starts. */
export async function pollSQLiteAuthAttempt(
  id: string, scope: AiAuthScope, options: AuthProtocolOptions = {},
): Promise<AuthAttemptView> {
  const store = await sqliteStore();
  const result = store.transaction<AuthAttemptView | Claim>(executor => {
    const attempt = sqliteAuthAttempt(executor, id);
    requireAttemptScope(attempt, scope);
    const now = (options.now ?? Date.now)();
    if (attempt.expires_at.getTime() <= now) {
      const expired = { ...attempt, status: "expired" as const, payload: {} };
      saveSQLiteAuthAttempt(executor, expired);
      return authAttemptView(expired, now);
    }
    if (attempt.status !== "pending" || (attempt.next_poll_at?.getTime() ?? 0) > now) {
      return authAttemptView(attempt, now);
    }
    const payload = attempt.provider === "google" || attempt.provider === "openrouter"
      ? PkcePayloadSchema.parse(attempt.payload) : DevicePayloadSchema.parse(attempt.payload);
    if (payload.exchangeState === "in_flight" || (payload.kind === "pkce" && !payload.code)) {
      return authAttemptView(attempt, now);
    }
    const claimed = { ...payload, exchangeState: "in_flight" as const };
    const updated = { ...attempt, payload: claimed };
    saveSQLiteAuthAttempt(executor, updated);
    return { attempt: updated, payload: claimed };
  });
  if (!("attempt" in result)) return result;
  const attempt = result.attempt;
  let payload = result.payload;
  let credential: OAuthCredential | undefined;
  let deviceResult: DevicePollResult | undefined;
  let failure: OAuthProtocolError | undefined;
  // A token POST must not be replayed after an ambiguous response.
  let tokenExchange = payload.kind === "pkce";
  try {
    switch (attempt.provider) {
      case "google":
      case "openrouter":
        if (payload.kind !== "pkce" || !payload.code) throw new TypeError("Missing claimed authorization code");
        credential = attempt.provider === "google"
          ? await exchangeGoogleCode({ code: payload.code, verifier: payload.verifier }, options)
          : await exchangeOpenRouterCode({ code: payload.code, verifier: payload.verifier }, options);
        break;
      case "openai": {
        if (payload.kind !== "device") throw new TypeError("Missing device payload");
        if (!payload.openaiCode) {
          const polled = await pollOpenAiDeviceAuthorization(payload, options);
          switch (polled.status) {
            case "pending":
              deviceResult = { status: "pending" };
              break;
            case "denied":
              deviceResult = { status: "denied" };
              break;
            case "code": {
              const updatedPayload = { ...payload, openaiCode: polled.code };
              // Preserve the code durably before its one-time POST, and recheck
              // cancellation/expiry while provider work was outside the writer.
              const updated = store.transaction(executor => {
                const current = sqliteAuthAttempt(executor, id);
                requireAttemptScope(current, scope);
                const now = (options.now ?? Date.now)();
                if (current.expires_at.getTime() <= now) {
                  const expired = { ...current, status: "expired" as const, payload: {} };
                  saveSQLiteAuthAttempt(executor, expired);
                  return expired;
                }
                if (current.status !== "pending" || JSON.stringify(current.payload) !== JSON.stringify(payload)) {
                  throw new ApiError("conflict", aiAuthCopy.alreadyHandled);
                }
                const claimed = { ...current, payload: updatedPayload };
                saveSQLiteAuthAttempt(executor, claimed);
                return claimed;
              });
              if (updated.status !== "pending") return authAttemptView(updated, (options.now ?? Date.now)());
              payload = updatedPayload;
              break;
            }
            default: {
              const exhaustive: never = polled;
              return exhaustive;
            }
          }
        }
        if (payload.openaiCode) {
          tokenExchange = true;
          credential = await exchangeOpenAiCode(payload.openaiCode, options);
        }
        break;
      }
      case "github-copilot":
      case "xai":
        if (payload.kind !== "device") throw new TypeError("Missing device payload");
        deviceResult = await pollDeviceAuthorization(attempt.provider, payload.deviceCode, {
          ...options, enterpriseDomain: payload.enterpriseDomain, githubToken: payload.githubToken,
        });
        if (deviceResult.status === "complete") credential = deviceResult.credential;
        break;
      default: {
        const exhaustive: never = attempt.provider;
        return exhaustive;
      }
    }
  } catch (error) {
    if (error instanceof OAuthProtocolError) failure = error;
    else if (options.signal?.aborted) failure = new OAuthProtocolError(attempt.provider, "exchange cancelled");
    else throw error;
  }
  return store.transaction(executor => {
    const current = sqliteAuthAttempt(executor, id);
    requireAttemptScope(current, scope);
    const now = (options.now ?? Date.now)();
    let updated: AuthAttemptRow;
    if (current.expires_at.getTime() <= now) updated = { ...current, status: "expired", payload: {} };
    else if (current.status !== "pending" || JSON.stringify(current.payload) !== JSON.stringify(payload)) {
      return authAttemptView(current, now);
    } else if (credential) {
      updated = { ...current, status: "ready", payload: OAuthCredentialSchema.parse(credential) };
    } else if (deviceResult?.status === "denied" || deviceResult?.status === "expired") {
      updated = { ...current, status: deviceResult.status, payload: {} };
    } else if (deviceResult?.status === "pending" || deviceResult?.status === "slow_down"
      || (failure && failure.retryable && (!tokenExchange || (failure.status !== undefined
        && (failure.status === 429 || failure.status >= 500))))) {
      const interval = Math.min(3600, Math.max(
        (payload.intervalSeconds ?? 0) + (failure || deviceResult?.status === "slow_down" ? 5 : 0),
        deviceResult?.status === "pending" || deviceResult?.status === "slow_down" ? deviceResult.intervalSeconds ?? 0 : 0,
      ));
      const retryPayload = {
        ...payload, exchangeState: "prepared" as const, intervalSeconds: Math.max(1, interval),
        ...(deviceResult && "githubToken" in deviceResult && deviceResult.githubToken
          ? { githubToken: deviceResult.githubToken } : {}),
      };
      updated = { ...current, payload: retryPayload, next_poll_at: new Date(now + Math.max(1, interval) * 1000) };
    } else {
      const denied = failure?.code === "access_denied" || failure?.code === "authorization_declined";
      updated = { ...current, status: denied ? "denied" : "failed", payload: {} };
    }
    saveSQLiteAuthAttempt(executor, updated);
    return authAttemptView(updated, now);
  });
}
