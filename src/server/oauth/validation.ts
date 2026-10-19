import { z } from "zod";
import { AgentScopeSchema, type AgentScope } from "@/lib/agent-access";
import { OAUTH_SCOPES } from "./metadata";
import { OAuthError, type Authorization, type ClientRow } from "./model";

const RedirectUri = z.string().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return value === value.trim() && !/[\u0000-\u0020\u007f\\]/.test(value) &&
      !value.includes("#") && !url.username && !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
  } catch { return false; }
});
const SUPPORTED_GRANTS = ["authorization_code", "refresh_token"] as const;
export const RegistrationSchema = z.object({
  redirect_uris: z.array(RedirectUri).min(1).max(5),
  client_name: z.string().trim().min(1).max(100).default("MCP client"),
  token_endpoint_auth_method: z.enum(["none", "client_secret_basic", "client_secret_post"]).default("none"),
  // RFC 7591 lets the server drop grant types it does not support (claude.ai also lists jwt-bearer).
  grant_types: z.array(z.string().min(1).max(200)).min(1).max(10)
    .refine(types => types.includes("authorization_code"), "authorization_code is required")
    .transform(types => SUPPORTED_GRANTS.filter(type => types.includes(type)))
    .default(["authorization_code", "refresh_token"]),
  response_types: z.array(z.literal("code")).length(1).default(["code"]),
});
export const AuthorizationSchema = z.object({
  client_id: z.string().min(1).max(2048), redirect_uri: z.string().min(1).max(2048),
  response_type: z.literal("code"), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"), state: z.string().max(2048).optional(),
  resource: z.string().max(2048).optional(), scope: z.string().max(100).optional(),
});
export const TokenRequestSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"), code: z.string().min(1).max(256),
    client_id: z.string().min(1).max(2048), redirect_uri: z.string().min(1).max(2048),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), resource: z.string().max(2048).optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"), refresh_token: z.string().min(1).max(256),
    client_id: z.string().min(1).max(2048), resource: z.string().max(2048).optional(),
    scope: z.string().max(100).optional(),
  }),
]);
export function parseScopes(value: string | undefined): AgentScope[] {
  if (value === undefined) return [...OAUTH_SCOPES];
  const result = z.array(AgentScopeSchema).min(1).max(3).safeParse(value.split(" "));
  if (!result.success || new Set(result.data).size !== result.data.length) {
    throw new OAuthError("invalid_scope", "Requested scopes are not supported");
  }
  return result.data;
}
export function singleParameters(params: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) throw new OAuthError("invalid_request", "Duplicate parameter");
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  return result;
}
export function authorization(raw: unknown, client: ClientRow | null, resource: string): Authorization {
  const input = AuthorizationSchema.parse(raw);
  if (!client || input.client_id !== client.id) throw new OAuthError("invalid_client", "Unknown client");
  const redirects = z.array(z.string()).parse(JSON.parse(client.redirect_uris));
  if (!redirects.includes(input.redirect_uri)) throw new OAuthError("invalid_request", "Unregistered redirect URI");
  if (input.resource !== undefined && input.resource !== resource) {
    throw new OAuthError("invalid_target", "Resource must be this MCP endpoint");
  }
  return { client, redirectUri: input.redirect_uri, challenge: input.code_challenge, state: input.state,
    scopes: parseScopes(input.scope), resource };
}
