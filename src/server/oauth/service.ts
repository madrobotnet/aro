import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AgentIdSchema, type AgentScope } from "@/lib/agent-access";
import { digest } from "@/server/agents/common";
import { clientIp } from "@/server/auth/client-ip";
import { databaseBackend } from "@/server/db/backend";
import { clientMetadata } from "./client-metadata";
import { OAuthError, secret, type Authorization, type ClientRow } from "./model";
import { authorization, AuthorizationSchema, parseScopes, RegistrationSchema, singleParameters, TokenRequestSchema } from "./validation";

async function backend() {
  return databaseBackend() === "sqlite" ? import("./sqlite") : import("./postgres");
}
export async function rateLimit(request: Request, registration = false): Promise<void> {
  const key = digest(`${registration ? "register" : "oauth"}:${clientIp(request.headers) ?? "unknown"}`);
  if (!await (await backend()).consumeRate(key, registration ? 3_600_000 : 60_000, registration ? 20 : 120)) {
    throw new OAuthError("temporarily_unavailable", "Too many OAuth requests", 429);
  }
}
export async function registerClient(raw: unknown) {
  const parsed = RegistrationSchema.safeParse(raw);
  if (!parsed.success) {
    const redirectError = parsed.error.issues.some(issue => issue.path[0] === "redirect_uris");
    throw new OAuthError(redirectError ? "invalid_redirect_uri" : "invalid_client_metadata", "Invalid client registration metadata");
  }
  const input = parsed.data;
  const credential = input.token_endpoint_auth_method === "none" ? null : secret();
  const client: ClientRow = {
    id: secret(), name: input.client_name, redirect_uris: JSON.stringify(input.redirect_uris), created_at: new Date(),
    auth_method: input.token_endpoint_auth_method, secret_hash: credential ? digest(credential) : null,
  };
  await (await backend()).register(client);
  return { ...input, client_id: client.id, client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
    ...(credential ? { client_secret: credential, client_secret_expires_at: 0 } : {}) };
}
async function resolveClient(id: string): Promise<ClientRow | null> {
  if (id.startsWith("https://")) {
    const client = await clientMetadata(id);
    await (await backend()).register(client);
    return client;
  }
  return (await backend()).findClient(id);
}
export async function validateAuthorization(params: URLSearchParams, resource: string): Promise<Authorization> {
  const raw = singleParameters(params);
  const input = AuthorizationSchema.parse(raw);
  return authorization(input, await resolveClient(input.client_id), resource);
}
export async function approve(auth: Authorization, ownerId: string, scopes: readonly AgentScope[]): Promise<string> {
  if (!scopes.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !auth.scopes.includes(scope))) {
    throw new OAuthError("invalid_scope", "Choose only requested permissions");
  }
  return (await backend()).issueCode(auth, ownerId, scopes);
}
type Credentials = { readonly id: string; readonly password?: string; readonly method: ClientRow["auth_method"] };
export function credentials(request: Request, params: Record<string, string>): Credentials {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
    if (!match?.[1] || params.client_secret !== undefined) throw new OAuthError("invalid_client", "Invalid client authentication", 401);
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) throw new OAuthError("invalid_client", "Invalid client authentication", 401);
    try {
      const id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
      const password = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "));
      if ((params.client_id !== undefined && params.client_id !== id) || !id || id.length > 2048 || password.length > 256) {
        throw new OAuthError("invalid_client", "Invalid client authentication", 401);
      }
      return { id, password, method: "client_secret_basic" };
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError("invalid_client", "Invalid client authentication", 401);
    }
  }
  const id = z.string().min(1).max(2048).parse(params.client_id);
  return { id, password: params.client_secret, method: params.client_secret === undefined ? "none" : "client_secret_post" };
}
async function authenticateClient(input: Credentials): Promise<ClientRow> {
  const client = await resolveClient(input.id);
  if (!client || client.auth_method !== input.method) throw new OAuthError("invalid_client", "Client authentication failed", 401);
  if (client.auth_method !== "none") {
    if (!input.password || input.password.length > 256 || !client.secret_hash ||
      !timingSafeEqual(Buffer.from(digest(input.password)), Buffer.from(client.secret_hash))) {
      throw new OAuthError("invalid_client", "Client authentication failed", 401);
    }
  }
  return client;
}
export async function exchangeToken(request: Request, params: Record<string, string>, resource: string) {
  const auth = credentials(request, params);
  const client = await authenticateClient(auth);
  if (!["authorization_code", "refresh_token"].includes(params.grant_type ?? "")) {
    throw new OAuthError("unsupported_grant_type", "Unsupported grant type");
  }
  const input = TokenRequestSchema.parse({ ...params, client_id: client.id });
  if (input.resource !== undefined && input.resource !== resource) throw new OAuthError("invalid_target", "Resource must be this MCP endpoint");
  if (input.grant_type === "authorization_code" &&
      !z.array(z.string()).parse(JSON.parse(client.redirect_uris)).includes(input.redirect_uri)) {
    throw new OAuthError("invalid_grant", "Redirect URI is no longer registered for this client");
  }
  const common = { clientId: client.id, resource, now: new Date() };
  const output = await (await backend()).exchange(input.grant_type === "authorization_code"
    ? { ...common, kind: "code", hash: digest(input.code), redirectUri: input.redirect_uri, verifier: input.code_verifier }
    : { ...common, kind: "refresh", hash: digest(input.refresh_token),
      scopes: input.scope === undefined ? undefined : parseScopes(input.scope) });
  if (!output) throw new OAuthError("invalid_grant", "Grant is invalid, expired or already used");
  return output;
}
export async function revokeToken(request: Request, params: Record<string, string>): Promise<void> {
  const token = z.string().min(1).max(256).parse(params.token);
  const client = params.client_id !== undefined || request.headers.has("authorization")
    ? await authenticateClient(credentials(request, params)) : null;
  await (await backend()).revokeSecret(digest(token), client?.id);
}
export async function listConnections(ownerId: string) {
  return (await backend()).listConnections(ownerId);
}
export async function revokeConnection(id: string, ownerId: string) {
  return (await backend()).revokeConnection(AgentIdSchema.parse(id), ownerId);
}
export async function updateAllowedNotes(id: string, ownerId: string, raw: unknown) {
  const notes = z.object({ allowedNoteIds: z.array(AgentIdSchema).max(100) }).strict().parse(raw);
  return (await backend()).updateAllowedNotes(AgentIdSchema.parse(id), ownerId, [...new Set(notes.allowedNoteIds)]);
}
