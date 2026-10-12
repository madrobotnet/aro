import { cookies } from "next/headers";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "@/server/auth/config";
import { revokeToken } from "@/server/auth/session";
import { json, withPublicApi } from "@/server/http";

export const POST = withPublicApi(async () => {
  const store = await cookies();
  for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
    const token = store.get(name)?.value;
    if (token) await revokeToken(token);
    store.delete(name);
  }
  return json({ ok: true });
});
