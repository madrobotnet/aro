// A separate process gives Next's real request stores their normal runtime initialization,
// without globally mocking cookies/auth in the shared Bun test process.
import "next/dist/server/node-environment-baseline.js";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store.js";
import { createWorkStore } from "next/dist/server/async-storage/work-store.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { GET, POST } from "@/app/api/capture/route";
import { inboxFixture } from "./sqlite-test-fixture";
import { createSQLiteSession } from "@/server/auth/sqlite";
import { sqliteTimestamp } from "@/server/db/sqlite";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { setJevForTests } from "@/server/jev/client";

const f = await inboxFixture();
let providerCalls = 0;
setJevForTests(new TypeSafeClient({
  apiKey: "test", logLevel: "off", retry: { maxRetries: 0 },
  fetch: async () => { providerCalls += 1; throw new Error("Provider work forbidden for queued capture"); },
}));
try {
  const session = createSQLiteSession(f.store, { passwordHash: "hash", userAgent: null, ip: null });
  let afterRegistered = 0;
  async function request(method, token, body) {
    const req = new NextRequest("https://irang.example/api/capture", {
      method,
      headers: { cookie: `sb_session=${token}`, origin: "https://irang.example", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const tags = { tags: [], expirationsByCacheKind: new Map() };
    const requestStore = createRequestStoreForAPI(req, req.nextUrl, tags, undefined, undefined, undefined);
    const workStore = createWorkStore({
      page: "/api/capture/route", buildId: "test", deploymentId: "test", previouslyRevalidatedTags: [],
      renderOpts: {
        supportsDynamicResponse: true, experimental: {}, cacheLifeProfiles: {}, cacheComponents: false,
        onClose: () => {}, waitUntil: () => { afterRegistered += 1; },
      },
    });
    return workAsyncStorage.run(workStore, () =>
      workUnitAsyncStorage.run(requestStore, () => (method === "GET" ? GET : POST)(req, {})));
  }
  const identityResponse = await request("GET", session.token);
  assert.equal(identityResponse.status, 200);
  assert.equal(identityResponse.headers.get("cache-control"), "private, no-store");
  const identity = await identityResponse.json();
  const body = { requestId: crypto.randomUUID(), confirmedSessionId: identity.sessionId,
    text: "exact content", title: "queued", url: "https://example.com/link" };
  const first = await request("POST", session.token, body);
  assert.equal(first.status, 201);
  const original = await first.json();
  // Discarded first response: same UUID/content returns the exact committed outcome.
  const repeated = await request("POST", session.token, body);
  assert.equal(repeated.status, 201);
  assert.deepEqual(await repeated.json(), original);
  assert.equal(f.store.get("SELECT count(*) AS total FROM inbox_items").total, 1n);
  assert.equal(afterRegistered, 0);
  assert.equal(providerCalls, 0);
  assert.equal((await request("POST", session.token, { ...body, text: "altered" })).status, 409);
  assert.equal((await request("POST", session.token, { ...body, requestId: crypto.randomUUID(),
    confirmedSessionId: crypto.randomUUID() })).status, 409);
  const newLogin = createSQLiteSession(f.store, { passwordHash: "hash", userAgent: null, ip: null });
  assert.equal((await request("POST", newLogin.token, body)).status, 409);
  const refreshed = await (await request("GET", newLogin.token)).json();
  assert.equal((await request("POST", newLogin.token, { ...body, confirmedSessionId: refreshed.sessionId })).status, 201);
  f.store.run("UPDATE sessions SET expires_at=?", [sqliteTimestamp(new Date("2000-01-01T00:00:00Z"))]);
  assert.equal((await request("POST", newLogin.token, body)).status, 401);
  assert.equal((await request("GET", newLogin.token)).status, 401);
  assert.equal(f.store.get("SELECT count(*) AS total FROM inbox_items").total, 1n);
  const normalLogin = createSQLiteSession(f.store, { passwordHash: "hash", userAgent: null, ip: null });
  assert.equal((await request("POST", normalLogin.token, { text: "normal capture" })).status, 201);
  assert.equal(afterRegistered, 1);
  assert.equal(f.store.get("SELECT count(*) AS total FROM inbox_items").total, 2n);
  assert.equal(f.store.get("SELECT count(*) AS total FROM capture_requests").total, 1n);
  console.log("capture route: real owner auth, expiry, session changes, replay and normal after scheduling passed");
} finally { await f.close(); }
