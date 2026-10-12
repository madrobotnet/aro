import "next/dist/server/node-environment-baseline.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import argon2 from "argon2";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store.js";
import { createWorkStore } from "next/dist/server/async-storage/work-store.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as revokeAll } from "@/app/api/auth/sessions/revoke-all/route";
import { GET as capture } from "@/app/api/capture/route";
import { createSession, sessionFromToken } from "./session";
import { closeSQLiteStore } from "@/server/db/backend";

const directory = await mkdtemp(path.join(tmpdir(), "aro-cookie-"));
process.env.ARO_DATABASE_MODE = "sqlite";
process.env.ARO_SQLITE_PATH = path.join(directory, "auth.sqlite");
const password = "fixture-long-password";
process.env.AUTH_PASSWORD_HASH = await argon2.hash(password);

async function request(handler, method, cookie, body) {
  const req = new NextRequest("https://aro.example/api/auth/test", {
    method, headers: { cookie, origin: "https://aro.example", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const requestStore = createRequestStoreForAPI(req, req.nextUrl,
    { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined);
  const workStore = createWorkStore({
    page: "/api/auth/test/route", buildId: "test", deploymentId: "test", previouslyRevalidatedTags: [],
    renderOpts: { supportsDynamicResponse: true, experimental: {}, cacheLifeProfiles: {},
      cacheComponents: false, onClose: () => {}, waitUntil: () => {} },
  });
  const response = await workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, () => handler(req, {})));
  return { response, cookies: requestStore.mutableCookies };
}

try {
  // Given an owner logged in before the rename.
  const old = await createSession({ passwordHash: process.env.AUTH_PASSWORD_HASH, userAgent: null, ip: null });
  // When a real protected route receives only the legacy cookie.
  const accepted = await request(capture, "GET", `sb_session=${old.token}`);
  // Then the existing session still authenticates.
  assert.equal(accepted.response.status, 200);
  const identity = await accepted.response.json();

  // New cookie takes priority over an otherwise valid legacy cookie.
  assert.equal((await request(capture, "GET", `aro_session=invalid; sb_session=${old.token}`)).response.status, 401);

  // Login replaces the cookie name using the real password and session store.
  const loggedIn = await request(login, "POST", `sb_session=${old.token}`, { password });
  assert.equal(loggedIn.response.status, 200);
  const fresh = loggedIn.cookies.get("aro_session");
  assert.ok(fresh?.value);
  assert.equal(fresh.httpOnly, true);
  assert.equal(fresh.path, "/");
  assert.equal(loggedIn.cookies.get("sb_session")?.value, "");
  const freshIdentity = await (await request(capture, "GET", `aro_session=${fresh.value}`)).response.json();
  assert.equal(freshIdentity.ownerId, identity.ownerId);

  // Logout clears and revokes both tokens, including a still-present old cookie.
  const loggedOut = await request(logout, "POST", `aro_session=${fresh.value}; sb_session=${old.token}`);
  assert.equal(loggedOut.response.status, 200);
  for (const name of ["aro_session", "sb_session"]) {
    assert.equal(loggedOut.cookies.get(name)?.value, "");
    assert.equal(loggedOut.cookies.get(name)?.expires.getTime(), 0);
  }
  assert.equal(await sessionFromToken(old.token), null);
  assert.equal(await sessionFromToken(fresh.value), null);

  // Revoke-all authenticates legacy sessions and clears both names.
  const last = await createSession({ passwordHash: process.env.AUTH_PASSWORD_HASH, userAgent: null, ip: null });
  const revoked = await request(revokeAll, "POST", `sb_session=${last.token}`);
  assert.equal(revoked.response.status, 200);
  for (const name of ["aro_session", "sb_session"]) assert.equal(revoked.cookies.get(name)?.value, "");
  assert.equal(await sessionFromToken(last.token), null);
  console.log(JSON.stringify({ legacyAccepted: true, newPreferred: true, loginReplaced: true,
    logoutClearedBoth: true, revokeAllClearedBoth: true }));
} finally {
  await closeSQLiteStore();
  await rm(directory, { recursive: true, force: true });
}
