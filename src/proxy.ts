import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "aro_session";
const AI_AUTH_COOKIE = "sb_ai_auth";
const PUBLIC_PREFIXES = ["/login", "/api/auth/login", "/api/health", "/manifest.webmanifest", "/icons/", "/fonts/", "/favicon"];

function pageResponse(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  if (["/oauth/authorize", "/oauth/consent", "/oauth/authorize/decision"].includes(request.nextUrl.pathname)) {
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("content-security-policy", "frame-ancestors 'none'");
    response.headers.set("x-frame-options", "DENY");
  }
  if (request.method === "GET" && ["/setup", "/settings"].includes(request.nextUrl.pathname)
    && !/^[a-f0-9]{64}$/.test(request.cookies.get(AI_AUTH_COOKIE)?.value ?? "")) {
    // Establish one browser identity before chat and Jev can start logins together.
    const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    response.cookies.set(AI_AUTH_COOKIE, value, {
      httpOnly: true, sameSite: "lax", path: "/", maxAge: 3600,
      secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
    });
  }
  return response;
}

/**
 * Cheap gate: requests without a session cookie never reach app pages or APIs.
 * The real session check (DB) happens in the (app) layout and in withApi().
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (/^\/share\/[0-9a-f]{64}$/.test(pathname) && ["GET", "HEAD"].includes(request.method)) {
    const response = pageResponse(request);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    return response;
  }
  if (pathname === "/share" || pathname.startsWith("/share/")) {
    return new NextResponse("Not found.", {
      status: 404,
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow, noarchive",
      },
    });
  }
  if (pathname === "/setup" || pathname === "/api/setup" || pathname === "/connect/complete"
    || ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp",
      "/.well-known/oauth-authorization-server", "/oauth/authorize", "/oauth/consent", "/oauth/authorize/decision",
      "/oauth/register", "/oauth/token", "/oauth/revoke"].includes(pathname)
    || pathname === "/api/mcp" // This exact route performs independent scoped bearer authentication.
    || pathname === "/api/webhooks/capture" // Shares scoped agent authorization; never browser-cookie auth.
    || pathname === "/api/ai/auth" || pathname.startsWith("/api/ai/auth/")
    || PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return pageResponse(request);
  }
  if (request.cookies.get(SESSION_COOKIE)?.value || request.cookies.get("sb_session")?.value) {
    return pageResponse(request);
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Login required" } }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|sw.js).*)"],
};
