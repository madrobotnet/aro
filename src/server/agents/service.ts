import {
  AgentIdSchema, AgentListQuerySchema, AgentProposalQuerySchema, AgentToolCallSchema, CreateAgentTokenSchema,
  type AgentProposalDto, type AgentToolCall, type CreateAgentTokenInput,
} from "@/lib/agent-access";
import { databaseBackend } from "@/server/db/backend";
import { ApiError } from "@/server/http";

async function backend() {
  return databaseBackend() === "sqlite" ? import("./sqlite") : import("./postgres");
}
export async function createToken(input: CreateAgentTokenInput) {
  return (await backend()).createToken(CreateAgentTokenSchema.parse(input));
}
export async function listTokens() { return (await backend()).listTokens(); }
export async function revokeToken(id: string) { return (await backend()).revokeToken(AgentIdSchema.parse(id)); }
export async function listActivity(limit: number) {
  return (await backend()).listActivity(AgentListQuerySchema.parse({ limit }).limit);
}
export async function listProposals(status: AgentProposalDto["status"], limit: number) {
  const query = AgentProposalQuerySchema.parse({ status, limit });
  return (await backend()).listProposals(query.status, query.limit);
}
export async function reviewProposal(id: string, decision: "approved" | "rejected") {
  return (await backend()).reviewProposal(AgentIdSchema.parse(id), decision);
}
function bearerSecret(secret: string): void {
  if (!/^aro_agent_[A-Za-z0-9_-]{43}$/.test(secret)) throw new ApiError("unauthorized", "Agent bearer token required");
}
export async function authenticate(secret: string) {
  bearerSecret(secret);
  return (await backend()).authenticate(secret);
}
export async function callTool(secret: string, call: AgentToolCall) {
  bearerSecret(secret);
  return (await backend()).callTool(secret, AgentToolCallSchema.parse(call));
}
