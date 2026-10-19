import { z } from "zod";
import { AgentToolSchemas } from "@/lib/agent-access";
import { authenticate, callTool } from "@/server/agents/service";
import { readAgentJson, validateMcpOrigin } from "@/server/agents/transport";
import { ApiError, errorResponse } from "@/server/http";

export const runtime = "nodejs";

/** Optional inbound automation only; no outbound delivery or implicit enrichment. */
export async function POST(request: Request): Promise<Response> {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  try {
    validateMcpOrigin(request);
    const bearer = request.headers.get("authorization")?.match(/^Bearer (aro_agent_[A-Za-z0-9_-]{43})$/i)?.[1];
    if (!bearer) throw new ApiError("unauthorized", "Agent bearer token required");
    const token = await authenticate(bearer);
    if (token.resource !== null) throw new ApiError("unauthorized", "OAuth tokens are bound to the MCP resource");
    const args = AgentToolSchemas.capture_inbox.parse(await readAgentJson(request));
    const result = await callTool(bearer, { name: "capture_inbox", arguments: args });
    return new Response(JSON.stringify(result), { status: 202, headers });
  } catch (error) {
    const code = error instanceof ApiError ? error.code : error instanceof z.ZodError ? "validation" : "internal";
    const response = errorResponse(code, code === "internal" ? "Webhook request failed" : "Webhook request was not authorized or valid");
    if (code === "unauthorized") response.headers.set("WWW-Authenticate", "Bearer");
    return response;
  }
}
