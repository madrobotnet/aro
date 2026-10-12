import { cookies } from "next/headers";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "@/server/auth/config";
import { revokeAllSessions } from "@/server/auth/session";
import { json, withApi } from "@/server/http";

export const POST = withApi(async () => {
  const revoked = await revokeAllSessions();
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(LEGACY_SESSION_COOKIE);
  return json({ ok: true, revoked });
});
