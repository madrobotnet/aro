import { AgentListQuerySchema } from "@/lib/agent-access";
import { listActivity } from "@/server/agents/service";
import { json, withApi } from "@/server/http";

export const runtime = "nodejs";
export const GET = withApi(async (request) => {
  const { limit } = AgentListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  return json({ activity: await listActivity(limit) });
});
