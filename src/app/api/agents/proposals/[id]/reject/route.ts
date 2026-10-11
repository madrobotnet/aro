import { reviewProposal } from "@/server/agents/service";
import { json, withApi } from "@/server/http";

export const runtime = "nodejs";
export const POST = withApi(async (_request, context: { params: Promise<{ id: string }> }) =>
  json({ proposal: await reviewProposal((await context.params).id, "rejected") }),
);
