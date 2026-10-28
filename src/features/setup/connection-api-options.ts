import type { ChatInput } from "@/lib/ai-connections";
import type { ChatConnectionView } from "@/lib/ai-settings";
import { BaseUrlSchema, ExtraHeadersSchema } from "@/lib/ai-provider-options";
import { isCustomProvider } from "@/lib/ai-providers";
import type { ConnectionErrorKey } from "./ai-copy";
import type { ChatFormState, ConnectionErrors } from "./connection-form-types";

type ChatApiOptions = Readonly<Omit<Extract<ChatInput, { mode: "api" }>, "mode" | "provider" | "model">>;

function isUrl(value: string): boolean {
  try {
    return new URL(value).href.length > 0;
  } catch {
    return false;
  }
}

/** Reason for a rejected base URL, from the schema's issue code and the value (never its message text). */
function baseUrlError(value: string, issueCode: string | undefined): ConnectionErrorKey {
  if (!value.trim()) return "baseUrlRequired";
  if (issueCode === "too_big") return "baseUrlTooLong";
  return isUrl(value.trim()) ? "baseUrlUnsafe" : "baseUrlInvalid";
}

function parseHeaders(value: string, errors: ConnectionErrors): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    errors.headers = "headersNotObject";
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    errors.headers = "headersNotObject";
    return null;
  }
  const result = ExtraHeadersSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    // Custom issues are the schema's own rules: the header count (whole object) or a reserved/duplicate name.
    errors.headers = issue?.code !== "custom" ? "headersInvalid" : issue.path.length === 0 ? "headersTooMany" : "headersReserved";
    return null;
  }
  return result.data;
}

/** Parse API fields and add their failures to the connection's accumulated field errors. */
export function parseChatApiOptions(
  state: ChatFormState,
  saved: ChatConnectionView | null,
  errors: ConnectionErrors,
): ChatApiOptions {
  const custom = isCustomProvider(state.provider);
  const baseResult = custom ? BaseUrlSchema.safeParse(state.baseUrl) : null;
  if (custom && !baseResult?.success) {
    errors.baseUrl = baseUrlError(state.baseUrl, baseResult?.error.issues[0]?.code);
  }
  const baseUrl = baseResult?.success ? baseResult.data : undefined;
  const unchanged = saved?.mode === "api"
    && saved.provider === state.provider
    && (saved.baseUrl ?? "") === (baseUrl ?? "");
  const apiKey = state.apiKey.trim();
  if (!apiKey && !state.keyless && !(unchanged && saved?.hasApiKey)) {
    errors.apiKey = custom ? "apiKeyOrKeyless" : "apiKeyRequired";
  }
  let headers: Record<string, string> | undefined;
  if (custom && state.headerAction === "clear") headers = {};
  if (custom && state.headerAction === "replace") {
    const parsed = parseHeaders(state.headersJson, errors);
    if (parsed) headers = parsed;
  }
  const maxText = state.maxOutputTokens.trim();
  const maxOutputTokens = maxText ? Number(maxText) : undefined;
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 128_000)) {
    errors.maxOutputTokens = "maxOutputTokensRange";
  }
  return {
    ...(apiKey ? { apiKey } : state.keyless && custom ? { apiKey: "" } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(custom || state.provider === "github-copilot" ? { apiFormat: state.apiFormat } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}
