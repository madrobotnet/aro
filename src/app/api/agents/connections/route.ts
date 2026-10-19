import { json, withApi } from "@/server/http";
import { oauthOwner } from "@/server/oauth/consent";
import { listConnections } from "@/server/oauth/service";

export const runtime = "nodejs";
export const GET = withApi(async () => json({ connections: await listConnections(await oauthOwner()) }));
