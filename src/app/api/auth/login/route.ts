import { cookies } from "next/headers";
import { z } from "zod";
import { clientIp } from "@/server/auth/client-ip";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "@/server/auth/config";
import { verifyLogin } from "@/server/auth/lockout";
import { createSession } from "@/server/auth/session";
import { ApiError, json, parseJson, withPublicApi } from "@/server/http";
import { loginPasswordHash } from "@/server/setup/service";
import { loginCopy } from "@/server/i18n/copy";

const Body = z.object({ password: z.string().min(1).max(512) });

export const POST = withPublicApi(async (request) => {
  const hash = await loginPasswordHash();
  if (!hash) throw new ApiError("unavailable", loginCopy.notConfigured);
  const { password } = await parseJson(request, Body);
  const ip = clientIp(request.headers);
  const clientKey = ip ?? "unknown";

  const result = await verifyLogin({ clientKey, password, hash });
  switch (result.kind) {
    case "locked":
      throw new ApiError("rate_limited", loginCopy.tooMany, { retryAfterSeconds: result.retryAfterSeconds });
    case "wrong_password":
      throw new ApiError("unauthorized", loginCopy.wrongPassword);
    case "accepted":
      break;
  }
  const session = await createSession({ passwordHash: hash, userAgent: request.headers.get("user-agent"), ip });
  const store = await cookies();
  store.delete(LEGACY_SESSION_COOKIE);
  store.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
    path: "/",
    expires: session.expiresAt,
  });
  return json({ ok: true });
});
