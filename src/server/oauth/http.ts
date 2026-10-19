import { z, ZodError } from "zod";
import { readAgentJson, readBoundedText } from "@/server/agents/body";
import { mcpOrigin } from "@/server/agents/origin";
import { ApiError } from "@/server/http";
import { OAUTH_CORS } from "./metadata";
import { OAuthError } from "./model";
import { exchangeToken, rateLimit, registerClient, revokeToken } from "./service";
import { singleParameters } from "./validation";

export function oauthJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { ...OAUTH_CORS, pragma: "no-cache" } });
}
export function oauthFailure(error: unknown): Response {
  if (error instanceof OAuthError) {
    const response = oauthJson({ error: error.code, error_description: error.message }, error.status);
    if (error.status === 401) response.headers.set("www-authenticate", 'Basic realm="Aro OAuth"');
    if (error.status === 429) response.headers.set("retry-after", "60");
    return response;
  }
  if (error instanceof ZodError) return oauthJson({ error: "invalid_request", error_description: "Invalid OAuth parameters" }, 400);
  if (error instanceof ApiError) {
    return oauthJson({ error: "invalid_request", error_description: error.message },
      error.code === "forbidden" ? 403 : error.code === "payload_too_large" ? 413 : 400);
  }
  // Do not log credentials, authorization URLs, or database error details.
  return oauthJson({ error: "server_error", error_description: "OAuth request failed" }, 500);
}
export async function readParameters(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type === "application/json") return z.record(z.string(), z.string()).parse(await readAgentJson(request));
  if (type !== "application/x-www-form-urlencoded") throw new OAuthError("invalid_request", "Form encoded body required");
  return singleParameters(new URLSearchParams(await readBoundedText(request)));
}
export async function registerPost(request: Request): Promise<Response> {
  try {
    mcpOrigin(request);
    await rateLimit(request, true);
    return oauthJson(await registerClient(await readAgentJson(request)), 201);
  } catch (error) { return oauthFailure(error); }
}
export async function tokenPost(request: Request): Promise<Response> {
  try {
    const resource = `${mcpOrigin(request)}/api/mcp`;
    await rateLimit(request);
    return oauthJson(await exchangeToken(request, await readParameters(request), resource));
  } catch (error) { return oauthFailure(error); }
}
export async function revokePost(request: Request): Promise<Response> {
  try {
    mcpOrigin(request);
    await rateLimit(request);
    await revokeToken(request, await readParameters(request));
  } catch {
    // RFC 7009: do not disclose whether a submitted token exists.
  }
  return new Response(null, { status: 200, headers: { ...OAUTH_CORS, pragma: "no-cache" } });
}
