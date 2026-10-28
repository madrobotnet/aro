import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { OAuthConsent } from "@/features/auth/OAuthConsent";
import { OAUTH_COPY } from "@/features/auth/oauth-copy";
import { getRequestLocale } from "@/lib/i18n/server";
import { mcpOrigin } from "@/server/agents/origin";
import { getSession } from "@/server/auth/session";
import { ApiError } from "@/server/http";
import { OAuthError, type Authorization } from "@/server/oauth/model";
import { rateLimit, validateAuthorization } from "@/server/oauth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: OAUTH_COPY[await getRequestLocale()].title, robots: { index: false, follow: false },
    referrer: "no-referrer" };
}
export default async function ConsentPage({ searchParams }: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, item);
  }
  let auth: Authorization;
  try {
    const request = new Request("http://localhost/oauth/authorize", { headers: await headers() });
    const origin = mcpOrigin(request);
    if (params.toString().length > 8192) throw new OAuthError("invalid_request", "Authorization URL is too long");
    await rateLimit(request);
    auth = await validateAuthorization(params, `${origin}/api/mcp`);
  } catch (error) {
    if (!(error instanceof OAuthError || error instanceof ApiError || error instanceof ZodError)) throw error;
    const copy = OAUTH_COPY[await getRequestLocale()];
    return <main className="flex min-h-dvh items-center justify-center bg-canvas bg-grain px-4 py-10">
      <section className="w-full max-w-lg surface-card p-6 sm:p-8">
        <h1 className="text-xl font-semibold">{copy.invalid}</h1>
        <p className="mt-3 text-sm text-mute" role="alert">{copy.invalidHelp}</p>
        <Link className="control-target focus-ring mt-6 inline-flex h-9 items-center rounded-ctl px-2 text-accent underline" href="/">{copy.home}</Link>
      </section>
    </main>;
  }
  if (!await getSession()) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${params}`)}`);
  return <main className="flex min-h-dvh items-center justify-center bg-canvas bg-grain px-4 py-10">
    <OAuthConsent clientName={auth.client.name} redirectHost={new URL(auth.redirectUri).host}
      request={params.toString()} scopes={auth.scopes} />
  </main>;
}
