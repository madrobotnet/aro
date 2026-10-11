import { CreateAgentTokenSchema } from "@/lib/agent-access";
import { createToken, listTokens } from "@/server/agents/service";
import { readAgentJson } from "@/server/agents/transport";
import { json, withApi } from "@/server/http";

export const runtime = "nodejs";
export const GET = withApi(async () => json({ tokens: await listTokens() }));
export const POST = withApi(async (request) => json(
  await createToken(CreateAgentTokenSchema.parse(await readAgentJson(request))), { status: 201 },
));
