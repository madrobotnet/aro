import { ApiError } from "@/server/http";

/** Only Host and the deployment allowlist establish authority, never forwarded headers. */
export function mcpOrigin(request: Request): string {
  const url = new URL(request.url);
  const authority = request.headers.get("host") ?? url.host;
  let parsed: URL;
  try { parsed = new URL(`http://${authority}`); }
  catch { throw new ApiError("forbidden", "Invalid MCP authority"); }
  if (parsed.host !== authority.toLowerCase() || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ApiError("forbidden", "Invalid MCP authority");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  const explicit = (process.env.ARO_MCP_ALLOWED_HOSTS ?? "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
  if (!(explicit.length ? explicit.includes(parsed.host) : local)) {
    throw new ApiError("forbidden", "MCP host is not allowed");
  }
  return `${local && url.protocol !== "https:" ? "http" : "https"}://${parsed.host}`;
}

/** MCP retains its same-origin browser boundary; OAuth public endpoints only validate Host. */
export function validateMcpOrigin(request: Request): void {
  const authority = new URL(mcpOrigin(request)).host;
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError("forbidden", "MCP host or origin is not allowed");
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let source: URL;
    try { source = new URL(origin); }
    catch { throw new ApiError("forbidden", "Invalid MCP origin"); }
    if (!["http:", "https:"].includes(source.protocol) || source.host !== authority ||
        source.username || source.password || source.origin !== origin) {
      throw new ApiError("forbidden", "MCP origin is not allowed");
    }
  }
}

export function mcpChallenge(request: Request): string {
  return `Bearer resource_metadata="${mcpOrigin(request)}/.well-known/oauth-protected-resource/api/mcp"${
    request.headers.has("authorization") ? ', error="invalid_token"' : ""}`;
}
