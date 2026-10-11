import { AgentProposalQuerySchema } from "@/lib/agent-access";
import { listProposals } from "@/server/agents/service";
import { json, withApi } from "@/server/http";

export const runtime = "nodejs";
export const GET = withApi(async (request) => {
  const { status, limit } = AgentProposalQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  return json({ proposals: await listProposals(status, limit) });
});
