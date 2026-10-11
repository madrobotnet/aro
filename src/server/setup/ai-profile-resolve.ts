import { setupCopy } from "@/server/i18n/setup-copy";
import type { PoolClient } from "pg";
import {
  ChatConnectionSchema, JevConnectionSchema,
  type ChatConnection, type JevConnection,
} from "@/lib/ai-settings";
import { StoredJevConnectionSchema, type ChatInput, type JevInput, type StoredJevConnection } from "@/lib/ai-connections";
import { isCustomProvider } from "@/lib/ai-providers";
import { consumeAuthAttempt, type AiAuthScope } from "@/server/ai-auth/attempt-store";
import type { OAuthCredential } from "@/lib/ai-auth";
import { ApiError } from "@/server/http";

export type ProfileResolveContext = {
  readonly client: PoolClient;
  readonly scope: AiAuthScope;
};

export async function resolveChatConnection(
  input: ChatInput,
  previous: ChatConnection | null,
  context: ProfileResolveContext,
): Promise<ChatConnection> {
  const credential = input.mode === "auth" && input.authAttemptId
    ? await consumeAuthAttempt(context.client, { id: input.authAttemptId, provider: input.provider, scope: context.scope })
    : undefined;
  return resolvedChatConnection(input, previous, credential);
}

export function resolvedChatConnection(
  input: ChatInput, previous: ChatConnection | null, granted?: OAuthCredential,
): ChatConnection {
  switch (input.mode) {
    case "api": {
      const unchanged = previous?.mode === "api"
        && previous.provider === input.provider && previous.baseUrl === input.baseUrl;
      const previousKey = unchanged && previous.mode === "api" ? previous.apiKey : undefined;
      const apiKey = input.apiKey ?? previousKey;
      if (apiKey === undefined) {
        throw new ApiError("validation", isCustomProvider(input.provider)
          ? setupCopy.keyOrKeyless
          : setupCopy.apiKey);
      }
      const headers = input.headers ?? (unchanged && previous.mode === "api" ? previous.headers : undefined);
      return ChatConnectionSchema.parse({ ...input, apiKey, ...(headers ? { headers } : {}) });
    }
    case "auth": {
      const { authAttemptId, ...connection } = input;
      switch (input.provider) {
        case "openai":
        case "google":
        case "github-copilot":
        case "openrouter":
        case "xai": {
          const previousCredential = previous?.mode === "auth"
            && previous.provider === input.provider && previous.enterpriseDomain === input.enterpriseDomain
            ? previous.credential : undefined;
          const credential = authAttemptId
            ? granted
            : previousCredential;
          // Existing file-backed profiles remain editable without replacing their
          // legacy credential source. New profiles must complete browser auth.
          if (!credential && !authAttemptId && (input.provider === "openai" || input.provider === "google")
            && previous?.mode === "auth" && previous.provider === input.provider) {
            return ChatConnectionSchema.parse(connection);
          }
          if (!credential) throw new ApiError("validation", setupCopy.signInFirst);
          if (credential?.provider === "github-copilot" && credential.enterpriseDomain !== input.enterpriseDomain) {
            throw new ApiError("validation", setupCopy.domainChanged);
          }
          return ChatConnectionSchema.parse({ ...connection, ...(credential ? { credential } : {}) });
        }
        default: {
          const exhaustive: never = input;
          return exhaustive;
        }
      }
    }
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

export async function resolveJevConnection(
  input: JevInput,
  previous: StoredJevConnection | null,
  context: ProfileResolveContext,
): Promise<StoredJevConnection> {
  const credential = input.mode === "auth" && input.authAttemptId
    ? await consumeAuthAttempt(context.client, { id: input.authAttemptId, provider: "openrouter", scope: context.scope })
    : undefined;
  return resolvedStoredJevConnection(input, previous, credential);
}

export function resolvedStoredJevConnection(
  input: JevInput, previous: StoredJevConnection | null, granted?: OAuthCredential,
): StoredJevConnection {
  if (input.mode === "auth") {
    const previousCredential = previous?.mode === "auth" ? previous.credential : undefined;
    const credential = input.authAttemptId
      ? granted
      : previousCredential;
    if (!credential) throw new ApiError("validation", setupCopy.openRouterFirst);
    return StoredJevConnectionSchema.parse({
      mode: "auth", provider: "openrouter", model: input.model,
      ...(credential ? { credential } : {}),
    });
  }
  const previousKey = previous && previous.mode !== "auth" && previous.provider === input.provider
    ? previous.apiKey : undefined;
  const apiKey = input.apiKey ?? previousKey;
  if (!apiKey) throw new ApiError("validation", setupCopy.jevApiKey);
  return JevConnectionSchema.parse({ provider: input.provider, model: input.model, apiKey });
}

export function resolvedJevConnection(connection: StoredJevConnection): JevConnection | null {
  if (connection.mode === "auth") {
    return connection.credential
      ? { provider: "openrouter", model: connection.model, apiKey: connection.credential.accessToken }
      : null;
  }
  return { provider: connection.provider, model: connection.model, apiKey: connection.apiKey };
}
