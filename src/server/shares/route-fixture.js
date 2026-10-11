// Isolated process: real Next request stores, session cookies and file-backed SQLite.
import "next/dist/server/node-environment-baseline.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store.js";
import { createWorkStore } from "next/dist/server/async-storage/work-store.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { GET, POST } from "@/app/api/notes/[id]/shares/route";
import { DELETE } from "@/app/api/notes/[id]/shares/[shareId]/route";
import { GET as publicGET } from "@/app/share/[token]/route";
import { createSQLiteSession } from "@/server/auth/sqlite";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { createNote } from "@/server/notes/service";

const directory = await mkdtemp(path.join(tmpdir(), "aro-share-route-"));
process.env.ARO_DATABASE_MODE = "sqlite";
process.env.ARO_SQLITE_PATH = path.join(directory, "routes.sqlite");
async function request(handler, method, params, token, body, origin = "https://irang.example") {
  const req = new NextRequest("https://irang.example/api/notes/test/shares", {
    method,
    headers: { cookie: `sb_session=${token}`, origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const requestStore = createRequestStoreForAPI(req, req.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined);
  const workStore = createWorkStore({
    page: "/api/notes/[id]/shares/route", buildId: "test", deploymentId: "test", previouslyRevalidatedTags: [],
    renderOpts: { supportsDynamicResponse: true, experimental: {}, cacheLifeProfiles: {}, cacheComponents: false, onClose: () => {}, waitUntil: () => {} },
  });
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, () => handler(req, { params: Promise.resolve(params) })));
}
try {
  const store = await sqliteStore();
  const session = createSQLiteSession(store, { passwordHash: "fixture", userAgent: null, ip: null });
  const note = await createNote({ title: "Route fixture", body: "![file](/api/attachments/private)\n<img src=https://example.test>" });
  const params = { id: note.id };
  assert.equal((await request(GET, "GET", params, "missing")).status, 401);
  assert.equal((await request(POST, "POST", params, session.token, { confirmed: true }, "https://evil.example")).status, 403);
  assert.equal((await request(POST, "POST", params, session.token, {})).status, 400);
  const created = await request(POST, "POST", params, session.token, { confirmed: true });
  assert.equal(created.status, 201);
  assert.match(created.headers.get("cache-control"), /no-store/);
  const result = await created.json();
  const token = result.path.slice("/share/".length);
  const listed = await (await request(GET, "GET", params, session.token)).json();
  assert.deepEqual(listed.shares, [result.share]);
  assert.equal(JSON.stringify(listed).includes(token), false);
  const readable = await request(publicGET, "GET", { token }, "");
  assert.equal(readable.status, 200);
  assert.equal((await readable.text()).includes("<img "), false);
  assert.equal((await request(DELETE, "DELETE", { ...params, shareId: result.share.id }, "", undefined)).status, 401);
  assert.equal((await request(DELETE, "DELETE", { ...params, shareId: result.share.id }, session.token, undefined, "https://evil.example")).status, 403);
  assert.equal((await request(DELETE, "DELETE", { ...params, shareId: result.share.id }, session.token)).status, 200);
  const denied = await request(publicGET, "GET", { token }, "");
  const unknown = await request(publicGET, "GET", { token: "b".repeat(64) }, "");
  assert.equal(denied.status, 404);
  assert.equal(await denied.text(), await unknown.text());
  const forbiddenMethod = await import("@/app/share/[token]/route");
  assert.equal("POST" in forbiddenMethod, false);
  assert.equal("DELETE" in forbiddenMethod, false);
  assert.equal("PATCH" in forbiddenMethod, false);
  console.log("share routes: real owner auth, CSRF, confirmation, snapshot read and revoke passed");
} finally {
  await closeSQLiteStore();
  await rm(directory, { recursive: true, force: true });
}
