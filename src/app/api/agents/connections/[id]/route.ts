import { readAgentJson } from "@/server/agents/body";
import { json, withApi } from "@/server/http";
import { oauthOwner } from "@/server/oauth/consent";
import { revokeConnection, updateAllowedNotes } from "@/server/oauth/service";

export const runtime = "nodejs";
type Context = { readonly params: Promise<{ id: string }> };
export const DELETE = withApi(async (_request, context: Context) => {
  await revokeConnection((await context.params).id, await oauthOwner());
  return json({ revoked: true });
});
export const PATCH = withApi(async (request, context: Context) => {
  await updateAllowedNotes((await context.params).id, await oauthOwner(), await readAgentJson(request));
  return json({ updated: true });
});
