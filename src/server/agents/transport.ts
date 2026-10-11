import { z, ZodError } from "zod";
import {
  AgentToolCallSchema, AgentToolSchemas, type AgentScope, type AgentToolName,
} from "@/lib/agent-access";
import { ApiError } from "@/server/http";
import { TOOL_SCOPES } from "./common";
import { authenticate, callTool } from "./service";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MAX_AGENT_BODY_BYTES = 96 * 1024;
const RpcId = z.union([z.string().max(200), z.int()]);
const Meta = z.record(z.string(), z.unknown()).optional();
const EmptyParams = z.object({ _meta: Meta }).strict();
const RpcMessage = z.object({
  jsonrpc: z.literal("2.0"), id: RpcId.optional(), method: z.string().min(1).max(100),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();
const InitializeParams = z.object({
  protocolVersion: z.string().min(1).max(30),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({
    name: z.string().min(1).max(200), version: z.string().min(1).max(100),
    title: z.string().max(200).optional(),
  }).strict(),
  _meta: Meta,
}).strict();
const ToolParams = z.object({
  name: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()).default({}), _meta: Meta,
}).strict();
const Descriptions: Readonly<Record<AgentToolName, string>> = {
  search_notes: "Search active notes locally with bounded lexical results; no AI or URL enrichment.",
  get_note: "Read a bounded note body slice and its opaque version for a proposed update.",
  capture_inbox: "Capture plain text into the owner's inbox. Request UUID is idempotent; never creates a note.",
  propose_note_update: "Queue an update to an explicitly allowed note for owner approval; never directly writes notes.",
};
const ToolNames: readonly AgentToolName[] = ["search_notes", "get_note", "capture_inbox", "propose_note_update"];
export function listedTools(scopes: readonly AgentScope[]) {
  return ToolNames.filter((name) => scopes.includes(TOOL_SCOPES[name])).map((name) => {
    const inputSchema = z.toJSONSchema(AgentToolSchemas[name], { io: "input" });
    if (name === "propose_note_update") {
      const patch = inputSchema.properties?.patch;
      if (patch && typeof patch === "object") patch.minProperties = 1;
    }
    return {
      name, description: Descriptions[name], inputSchema,
      annotations: {
        readOnlyHint: TOOL_SCOPES[name] === "read", destructiveHint: false,
        idempotentHint: true, openWorldHint: false,
      },
    };
  });
}
function response(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "private, no-store" } });
}
function rpcError(id: string | number | null, code: number, message: string, status = 200): Response {
  return response({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

/** The authority allowlist is independent of user-supplied Host/Origin/forwarded headers. */
export function validateMcpOrigin(request: Request): void {
  const url = new URL(request.url);
  const authority = request.headers.get("host") ?? url.host;
  let parsed: URL;
  try { parsed = new URL(`${url.protocol}//${authority}`); }
  catch { throw new ApiError("forbidden", "Invalid MCP authority"); }
  if (parsed.host !== authority.toLowerCase() || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ApiError("forbidden", "Invalid MCP authority");
  }
  const explicit = (process.env.ARO_MCP_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  const allowed = explicit.length
    ? explicit.includes(parsed.host)
    : ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (!allowed || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError("forbidden", "MCP host or origin is not allowed");
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let source: URL;
    try { source = new URL(origin); }
    catch { throw new ApiError("forbidden", "Invalid MCP origin"); }
    if (!["http:", "https:"].includes(source.protocol) || source.host !== parsed.host ||
        source.username || source.password || source.origin !== origin) {
      throw new ApiError("forbidden", "MCP origin is not allowed");
    }
  }
}
function accepts(request: Request, type: string): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((item) => {
    const [media, ...parameters] = item.trim().toLowerCase().split(";");
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    return media === type && (!quality || Number(quality.trim().slice(2)) > 0);
  });
}
export async function readAgentJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new ApiError("validation", "Content-Type application/json is required");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_AGENT_BODY_BYTES)) {
    throw new ApiError("payload_too_large", "Agent request exceeds 96 KiB");
  }
  if (!request.body) throw new ApiError("validation", "JSON body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_AGENT_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError("payload_too_large", "Agent request exceeds 96 KiB");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ApiError("validation", "Invalid UTF-8 JSON body"); }
}
function bearer(request: Request): string {
  const match = /^Bearer (aro_agent_[A-Za-z0-9_-]{43})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match?.[1]) throw new ApiError("unauthorized", "Agent bearer token required");
  return match[1];
}
export async function mcpPost(request: Request): Promise<Response> {
  let id: string | number | null = null;
  let stage: "body" | "message" | "params" = "body";
  try {
    validateMcpOrigin(request);
    const secret = bearer(request);
    const token = await authenticate(secret);
    if (!accepts(request, "application/json") || !accepts(request, "text/event-stream")) {
      return rpcError(null, -32600, "Accept must include application/json and text/event-stream", 406);
    }
    const raw = await readAgentJson(request);
    stage = "message";
    const message = RpcMessage.parse(raw);
    id = message.id ?? null;
    const version = request.headers.get("mcp-protocol-version");
    if ((message.method !== "initialize" && version !== MCP_PROTOCOL_VERSION) ||
        (version !== null && version !== MCP_PROTOCOL_VERSION)) {
      return rpcError(id, -32600, "Unsupported or missing MCP-Protocol-Version", 400);
    }
    stage = "params";
    if (message.id === undefined) {
      switch (message.method) {
        case "notifications/initialized":
          EmptyParams.parse(message.params ?? {});
          break;
        case "notifications/cancelled":
          z.object({ requestId: RpcId, reason: z.string().max(200).optional(), _meta: Meta }).strict().parse(message.params);
          break;
        case "notifications/progress":
          z.object({
            progressToken: RpcId, progress: z.number().nonnegative(), total: z.number().nonnegative().optional(),
            message: z.string().max(200).optional(), _meta: Meta,
          }).strict().parse(message.params);
          break;
        default:
          return rpcError(null, -32600, "Unsupported notification", 400);
      }
      return new Response(null, { status: 202, headers: { "cache-control": "private, no-store" } });
    }
    let result: unknown;
    switch (message.method) {
      case "initialize":
        InitializeParams.parse(message.params);
        result = {
          protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "aro-agent-access", version: "1.0.0" },
          instructions: "Owner-created static bearer access. Writes capture into inbox or queue owner-reviewed proposals. No OAuth, implicit enrichment, or direct note creation.",
        };
        break;
      case "ping":
        EmptyParams.parse(message.params ?? {});
        result = {};
        break;
      case "tools/list":
        // All four bounded tools fit one page; no cursors are issued.
        EmptyParams.parse(message.params ?? {});
        result = { tools: listedTools(token.scopes) };
        break;
      case "tools/call": {
        const params = ToolParams.parse(message.params);
        const call = AgentToolCallSchema.parse({ name: params.name, arguments: params.arguments });
        try {
          const output = await callTool(secret, call);
          result = { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output, isError: false };
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          result = { content: [{ type: "text", text: JSON.stringify({ code: error.code, message: error.message }) }], isError: true };
        }
        break;
      }
      default:
        return rpcError(id, -32601, "Method not found");
    }
    return response({ jsonrpc: "2.0", id, result });
  } catch (error) {
    if (error instanceof ZodError) {
      return rpcError(id, stage === "message" ? -32600 : -32602,
        stage === "message" ? "Invalid JSON-RPC message" : "Invalid method parameters", stage === "message" || id === null ? 400 : 200);
    }
    if (error instanceof ApiError) {
      const statuses: Partial<Record<ApiError["code"], number>> = { unauthorized: 401, forbidden: 403, payload_too_large: 413 };
      const status = statuses[error.code] ?? 400;
      const rejected = rpcError(id, error.code === "validation" && stage === "body" ? -32700 : -32600, error.message, status);
      if (status === 401) rejected.headers.set("www-authenticate", "Bearer");
      return rejected;
    }
    // Never log untrusted input, token hashes, SQL error details, note bodies or secrets.
    return rpcError(id, -32603, "Internal agent-access error", 500);
  }
}
export function mcpNoStream(request: Request): Response {
  try {
    validateMcpOrigin(request);
    return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "private, no-store" } });
  } catch {
    return rpcError(null, -32600, "MCP host or origin is not allowed", 403);
  }
}
