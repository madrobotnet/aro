import { mcpOrigin } from "@/server/agents/origin";
import { getSession } from "@/server/auth/session";
import { oauthFailure } from "@/server/oauth/http";
import { OAuthError } from "@/server/oauth/model";
import { rateLimit, validateAuthorization } from "@/server/oauth/service";

export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  try {
    const origin = mcpOrigin(request);
    const params = new URL(request.url).searchParams;
    if (params.toString().length > 8192) throw new OAuthError("invalid_request", "Authorization URL is too long");
    await rateLimit(request);
    await validateAuthorization(params, `${origin}/api/mcp`);
    const next = `/oauth/authorize?${params}`;
    const destination = await getSession()
      ? `/oauth/consent?${params}` : `/login?next=${encodeURIComponent(next)}`;
    return new Response(null, { status: 303, headers: {
      location: `${origin}${destination}`, "cache-control": "no-store", "referrer-policy": "no-referrer",
    } });
  } catch (error) { return oauthFailure(error); }
}
