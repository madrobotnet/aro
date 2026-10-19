import { mcpOrigin } from "@/server/agents/origin";
import { ApiError } from "@/server/http";

export const OAUTH_SCOPES = ["read", "capture", "propose-write"] as const;
export const OAUTH_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
  "cache-control": "no-store",
} as const;

export function oauthOptions(request: Request): Response {
  try {
    mcpOrigin(request);
    return new Response(null, { status: 204, headers: OAUTH_CORS });
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 403 });
  }
}

export function metadata(request: Request, kind: "resource" | "server"): Response {
  try {
    const origin = mcpOrigin(request);
    const document = kind === "resource" ? {
      resource: `${origin}/api/mcp`, authorization_servers: [origin],
      scopes_supported: OAUTH_SCOPES, bearer_methods_supported: ["header"],
    } : {
      issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`, response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      client_id_metadata_document_supported: true,
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      scopes_supported: OAUTH_SCOPES,
    };
    return Response.json(document, { headers: OAUTH_CORS });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return Response.json({ error: "invalid_request" }, { status: 403 });
  }
}
