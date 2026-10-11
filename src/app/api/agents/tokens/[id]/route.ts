import { revokeToken } from "@/server/agents/service";
import { json, withApi } from "@/server/http";

export const runtime = "nodejs";
export const DELETE = withApi(async (_request, context: { params: Promise<{ id: string }> }) => {
  await revokeToken((await context.params).id);
  return json({ revoked: true });
});
