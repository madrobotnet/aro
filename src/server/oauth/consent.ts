import { z } from "zod";
import { AgentScopeSchema } from "@/lib/agent-access";
import { readAgentJson, readBoundedText } from "@/server/agents/body";
import { mcpOrigin } from "@/server/agents/origin";
import { getSession } from "@/server/auth/session";
import { ApiError, json, withApi } from "@/server/http";
import { approve, rateLimit, validateAuthorization } from "./service";
import { OAuthError } from "./model";

const Decision = z.object({
  request: z.string().min(1).max(8192), decision: z.enum(["approve", "deny"]),
  scopes: z.array(AgentScopeSchema).max(3).default([]),
}).strict();

export async function oauthOwner(): Promise<string> {
  const session = await getSession();
  if (!session) throw new ApiError("unauthorized", "Owner login required");
  return session.userId;
}

export const consentPost = withApi(async request => {
  const origin = mcpOrigin(request);
  // Browser forms always supply Origin. Requiring it also closes the no-Origin form case.
  if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError("forbidden", "Same-origin consent is required");
  }
  const ownerId = await oauthOwner();
  const jsonBody = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/json";
  let raw: unknown;
  if (jsonBody) raw = await readAgentJson(request);
  else {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") {
      throw new ApiError("validation", "Form encoded body required");
    }
    const form = new URLSearchParams(await readBoundedText(request));
    if (form.getAll("request").length !== 1 || form.getAll("decision").length !== 1) {
      throw new ApiError("validation", "Ambiguous consent parameters");
    }
    raw = { request: form.get("request"), decision: form.get("decision"), scopes: form.getAll("scopes") };
  }
  const input = Decision.parse(raw);
  try {
    await rateLimit(request);
    const auth = await validateAuthorization(new URLSearchParams(input.request), `${origin}/api/mcp`);
    const target = new URL(auth.redirectUri);
    if (input.decision === "deny") target.searchParams.set("error", "access_denied");
    else target.searchParams.set("code", await approve(auth, ownerId, input.scopes));
    if (auth.state !== undefined) target.searchParams.set("state", auth.state);
    const location = target.href;
    return jsonBody ? json({ redirectTo: location }) : new Response(null, {
      status: 303, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  } catch (error) {
    if (error instanceof OAuthError) throw new ApiError(error.status === 429 ? "rate_limited" : "validation", error.message);
    throw error;
  }
});
