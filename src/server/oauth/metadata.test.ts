import { afterEach, expect, test } from "bun:test";
import { GET as resource } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as scopedResource } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as server, OPTIONS } from "@/app/.well-known/oauth-authorization-server/route";
import { mcpOrigin, mcpChallenge } from "@/server/agents/origin";

const hosts = process.env.ARO_MCP_ALLOWED_HOSTS;
afterEach(() => {
  if (hosts === undefined) delete process.env.ARO_MCP_ALLOWED_HOSTS;
  else process.env.ARO_MCP_ALLOWED_HOSTS = hosts;
});

test("both resource discovery paths describe the validated MCP resource", async () => {
  delete process.env.ARO_MCP_ALLOWED_HOSTS;
  const request = new Request("http://localhost:3000/.well-known/oauth-protected-resource");
  const document = {
    resource: "http://localhost:3000/api/mcp", authorization_servers: ["http://localhost:3000"],
    scopes_supported: ["read", "capture", "propose-write"], bearer_methods_supported: ["header"],
  };
  expect(await resource(request).json()).toEqual(document);
  expect(await scopedResource(request).json()).toEqual(document);
});

test("server discovery advertises public PKCE endpoints behind TLS termination", async () => {
  process.env.ARO_MCP_ALLOWED_HOSTS = "aro.example";
  const response = server(new Request("http://internal:3000/.well-known/oauth-authorization-server", {
    headers: { host: "aro.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
  }));
  expect(await response.json()).toEqual({
    issuer: "https://aro.example", authorization_endpoint: "https://aro.example/oauth/authorize",
    token_endpoint: "https://aro.example/oauth/token", registration_endpoint: "https://aro.example/oauth/register",
    revocation_endpoint: "https://aro.example/oauth/revoke", response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    client_id_metadata_document_supported: true,
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: ["read", "capture", "propose-write"],
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("untrusted or malformed Host cannot be reflected in discovery or challenges", async () => {
  process.env.ARO_MCP_ALLOWED_HOSTS = "aro.example";
  for (const host of ["evil.example", "aro.example@evil.example", "aro.example/path", "aro.example?x", "aro.example#x"]) {
    const request = new Request("http://localhost:3000/", { headers: { host } });
    expect(resource(request).status).toBe(403);
    expect(JSON.stringify(await server(request).json())).not.toContain(host);
    expect(() => mcpOrigin(request)).toThrow();
  }
});

test("metadata permits credential-free browser discovery and preflight", () => {
  delete process.env.ARO_MCP_ALLOWED_HOSTS;
  const request = new Request("http://localhost:3000/", {
    headers: { origin: "https://connector.example", "sec-fetch-site": "cross-site" },
  });
  expect(resource(request).status).toBe(200);
  expect(OPTIONS(request).status).toBe(204);
  expect(OPTIONS(request).headers.get("access-control-allow-origin")).toBe("*");
  expect(OPTIONS(request).headers.has("access-control-allow-credentials")).toBe(false);
});

test("challenge differentiates missing credentials from a presented invalid token", () => {
  delete process.env.ARO_MCP_ALLOWED_HOSTS;
  const request = new Request("http://localhost:3000/api/mcp");
  expect(mcpChallenge(request)).toBe('Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp", scope="read capture"');
  request.headers.set("authorization", "Bearer invalid");
  expect(mcpChallenge(request)).toEndWith(', error="invalid_token"');
});
