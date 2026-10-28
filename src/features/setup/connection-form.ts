import type { ChatInput, JevInput } from "@/lib/ai-connections";
import {
  AI_PROVIDERS,
  JEV_PROVIDERS,
  type AiProvider,
  type ChatConnectionView,
  type JevConnectionView,
  type JevProvider,
} from "@/lib/ai-settings";
import { ModelSchema } from "@/lib/ai-provider-options";
import { isCustomProvider } from "@/lib/ai-providers";
import { chatAuthModels, JEV_AUTH_MODELS } from "@/lib/ai-model-catalog";
import { isSelectableAuthModel, savedModelFor } from "./model-choice";
import { parseChatApiOptions } from "./connection-api-options";
import type {
  BuildConnectionResult,
  ChatFormState,
  ConnectionErrors,
  JevFormState,
} from "./connection-form-types";

export type {
  BuildConnectionResult,
  ChatFormState,
  ConnectionErrors,
  ConnectionFieldKey,
  HeaderAction,
  JevFormState,
} from "./connection-form-types";

export const chatProviderInfo = (provider: AiProvider) =>
  AI_PROVIDERS.find((entry) => entry.id === provider) ?? AI_PROVIDERS[0];

export const jevProviderInfo = (provider: JevProvider) =>
  JEV_PROVIDERS.find((entry) => entry.id === provider) ?? JEV_PROVIDERS[0];

export const providerSupportsAuth = (provider: AiProvider): boolean =>
  chatProviderInfo(provider).supportsAuth;

function isAuthProvider(
  provider: AiProvider,
): provider is "openai" | "google" | "github-copilot" | "openrouter" | "xai" {
  return provider === "openai"
    || provider === "google"
    || provider === "github-copilot"
    || provider === "openrouter"
    || provider === "xai";
}

export function emptyChatForm(): ChatFormState {
  return {
    enabled: false,
    name: "",
    mode: "api",
    provider: "openai",
    model: chatProviderInfo("openai").model,
    apiKey: "",
    keyless: false,
    baseUrl: "",
    apiFormat: "chat-completions",
    headersJson: "",
    headerAction: "retain",
    maxOutputTokens: "",
    enterpriseDomain: "",
    consent: false,
  };
}

export function emptyJevForm(): JevFormState {
  return {
    enabled: false,
    name: "",
    mode: "api",
    provider: "typesafe",
    model: jevProviderInfo("typesafe").model,
    apiKey: "",
    consent: false,
  };
}

export function chatFormFromView(view: ChatConnectionView, name = ""): ChatFormState {
  return {
    ...emptyChatForm(),
    enabled: true,
    name,
    mode: view.mode,
    provider: view.provider,
    model: view.model,
    keyless: view.mode === "api" && isCustomProvider(view.provider) && !view.hasApiKey,
    baseUrl: view.baseUrl ?? "",
    apiFormat: view.apiFormat ?? (view.provider === "github-copilot" ? "responses"
      : view.provider === "anthropic-compatible" ? "anthropic-messages" : "chat-completions"),
    maxOutputTokens: view.maxOutputTokens?.toString() ?? "",
    enterpriseDomain: view.enterpriseDomain ?? "",
    consent: true,
  };
}

export function jevFormFromView(view: JevConnectionView, name = ""): JevFormState {
  return {
    ...emptyJevForm(),
    enabled: true,
    name,
    mode: view.mode ?? "api",
    provider: view.provider,
    model: view.model,
    consent: true,
  };
}

function parseModel(model: string, errors: ConnectionErrors): string | null {
  const result = ModelSchema.safeParse(model);
  if (!result.success) {
    errors.model = "modelFormat";
    return null;
  }
  return result.data;
}

export function buildChatConnection(
  state: ChatFormState,
  saved: ChatConnectionView | null,
): BuildConnectionResult<ChatInput> {
  const errors: ConnectionErrors = {};
  const model = parseModel(state.model, errors);
  if (!state.consent) errors.consent = "chatConsent";
  if (state.mode === "auth") {
    const enterpriseDomain = state.enterpriseDomain.trim();
    const unchanged = saved?.mode === "auth"
      && saved.provider === state.provider
      && (saved.enterpriseDomain ?? "") === enterpriseDomain;
    // Existing OpenAI/Google profiles may use the server's CLI login file; the server keeps it.
    const legacyFileAuth = state.provider === "openai" || state.provider === "google";
    const keepsSavedLogin = unchanged && (Boolean(saved?.hasCredential) || legacyFileAuth);
    if (!isAuthProvider(state.provider)) errors.provider = "apiKeyOnly";
    const catalog = chatAuthModels(state.provider);
    if (model && catalog && !isSelectableAuthModel(catalog, model, savedModelFor(saved, state.provider, "auth"))) {
      errors.model = "authModelRequired";
    }
    if (isAuthProvider(state.provider) && !state.authAttemptId && !keepsSavedLogin) {
      errors.auth = "browserLoginRequired";
    }
    if (Object.keys(errors).length > 0 || !model || !isAuthProvider(state.provider)) return { ok: false, errors };
    return {
      ok: true,
      connection: {
        mode: "auth",
        provider: state.provider,
        model,
        ...(state.provider === "github-copilot" && state.apiFormat ? { apiFormat: state.apiFormat } : {}),
        ...(state.provider === "github-copilot" && enterpriseDomain ? { enterpriseDomain } : {}),
        ...(state.authAttemptId ? { authAttemptId: state.authAttemptId } : {}),
      },
    };
  }

  const options = parseChatApiOptions(state, saved, errors);
  if (Object.keys(errors).length > 0 || !model) return { ok: false, errors };
  return {
    ok: true,
    connection: {
      mode: "api",
      provider: state.provider,
      model,
      ...options,
    },
  };
}

export function buildJevConnection(
  state: JevFormState,
  saved: JevConnectionView | null,
): BuildConnectionResult<JevInput> {
  const errors: ConnectionErrors = {};
  const model = parseModel(state.model, errors);
  if (!state.consent) errors.consent = "jevConsent";
  if (state.mode === "auth") {
    const unchanged = saved?.mode === "auth" && saved.provider === "openrouter";
    if (state.provider !== "openrouter") errors.provider = "typesafeApiKeyOnly";
    if (model && !isSelectableAuthModel(JEV_AUTH_MODELS.openrouter, model, savedModelFor(saved, "openrouter", "auth"))) {
      errors.model = "authModelRequired";
    }
    if (!state.authAttemptId && !(unchanged && saved?.hasCredential)) errors.auth = "openRouterLoginRequired";
    if (Object.keys(errors).length > 0 || !model) return { ok: false, errors };
    return {
      ok: true,
      connection: {
        mode: "auth",
        provider: "openrouter",
        model,
        ...(state.authAttemptId ? { authAttemptId: state.authAttemptId } : {}),
      },
    };
  }
  const apiKey = state.apiKey.trim();
  const retained = saved?.provider === state.provider && (saved.mode ?? "api") === "api" && saved.hasApiKey;
  if (!apiKey && !retained) errors.apiKey = "jevApiKeyRequired";
  if (Object.keys(errors).length > 0 || !model) return { ok: false, errors };
  return {
    ok: true,
    connection: {
      mode: "api",
      provider: state.provider,
      model,
      ...(apiKey ? { apiKey } : {}),
    },
  };
}
