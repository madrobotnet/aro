// Real Next request contexts in a process isolated from the test runner.
import "next/dist/server/node-environment-baseline.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store.js";
import { createWorkStore } from "next/dist/server/async-storage/work-store.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { POST as decision } from "@/app/oauth/authorize/decision/route";
import { GET as authorize } from "@/app/oauth/authorize/route";
import { GET as connections } from "@/app/api/agents/connections/route";
import { DELETE as revoke, PATCH as allowedNotes } from "@/app/api/agents/connections/[id]/route";
import { POST as token } from "@/app/oauth/token/route";
import { createSession } from "@/server/auth/session";
import { authenticate } from "@/server/agents/service";
import { createNote } from "@/server/notes/service";
import { registerClient } from "./service";
import { closeSQLiteStore } from "@/server/db/backend";
import { closeDb, connectTestDatabase, resetData } from "@/server/test/db";

const mode = process.env.ARO_DATABASE_MODE;
const directory = await mkdtemp(path.join(tmpdir(), "aro-oauth-routes-"));
if (mode === "sqlite") process.env.ARO_SQLITE_PATH = path.join(directory, "routes.sqlite");
else { connectTestDatabase(); await resetData(); }
delete process.env.ARO_MCP_ALLOWED_HOSTS;
const origin = "http://localhost:3000";
async function request(handler, method, cookie, body, options = {}) {
  const req = new NextRequest(`${origin}${options.pathname ?? "/oauth/authorize/decision"}${options.search ?? ""}`, {
    method, headers: { cookie: `aro_session=${cookie}`, origin, "content-type": "application/json", ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const requestStore = createRequestStoreForAPI(req, req.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined);
  const workStore = createWorkStore({
    page: "/oauth/authorize/decision/route", buildId: "test", deploymentId: "test", previouslyRevalidatedTags: [],
    renderOpts: { supportsDynamicResponse: true, experimental: {}, cacheLifeProfiles: {}, cacheComponents: false,
      onClose: () => {}, waitUntil: () => {} },
  });
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, () =>
    handler(req, { params: Promise.resolve(options.params ?? {}) })));
}
try {
  const session = await createSession({ passwordHash: "fixture", userAgent: null, ip: null });
  const client = await registerClient({ client_name: "Route fixture", redirect_uris: ["https://chatgpt.com/fixture"] });
  const verifier = "a".repeat(43);
  const query = new URLSearchParams({
    client_id: client.client_id, redirect_uri: "https://chatgpt.com/fixture", response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    state: "owner supplied + / & state", scope: "read capture propose-write", resource: `${origin}/api/mcp`,
  });
  const body = { request: query.toString(), decision: "approve", scopes: ["read", "capture", "propose-write"] };
  assert.equal((await request(authorize, "GET", "")).status, 400);
  const authorizeOptions = { pathname: "/oauth/authorize", search: `?${query}` };
  const loginRedirect = await request(authorize, "GET", "", undefined, authorizeOptions);
  assert.equal(loginRedirect.status, 303);
  const loginTarget = new URL(loginRedirect.headers.get("location"));
  assert.equal(loginTarget.pathname, "/login");
  assert.equal(loginTarget.searchParams.get("next"), `/oauth/authorize?${query}`);
  const consentRedirect = await request(authorize, "GET", session.token, undefined, authorizeOptions);
  assert.equal(consentRedirect.status, 303);
  assert.equal(new URL(consentRedirect.headers.get("location")).pathname, "/oauth/consent");
  assert.equal((await request(decision, "POST", "missing", body)).status, 401);
  for (const headers of [{ origin: "https://evil.example" }, { origin: "" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await request(decision, "POST", session.token, body, { headers })).status, 403);
  }
  const malicious = new URLSearchParams(query);
  malicious.set("redirect_uri", "https://evil.example/callback");
  assert.equal((await request(authorize, "GET", session.token, undefined, { search: `?${malicious}` })).status, 400);
  assert.equal((await request(decision, "POST", session.token, { ...body, request: malicious.toString() })).status, 400);
  const denied = await request(decision, "POST", session.token, { ...body, decision: "deny" });
  const deniedTarget = new URL((await denied.json()).redirectTo);
  assert.equal(deniedTarget.searchParams.get("error"), "access_denied");
  assert.equal(deniedTarget.searchParams.get("state"), query.get("state"));
  assert.equal((await (await request(connections, "GET", session.token)).json()).connections.length, 0);
  const approved = await request(decision, "POST", session.token, body);
  const target = new URL((await approved.json()).redirectTo);
  assert.equal(target.origin, "https://chatgpt.com");
  assert.equal(target.searchParams.get("state"), query.get("state"));
  const issued = await token(new Request(`${origin}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: target.searchParams.get("code"),
      client_id: client.client_id, redirect_uri: "https://chatgpt.com/fixture", code_verifier: verifier }),
  }));
  assert.equal(issued.status, 200);
  const tokens = await issued.json();
  const listed = await (await request(connections, "GET", session.token)).json();
  assert.equal(listed.connections.length, 1);
  assert.equal(listed.connections[0].clientName, "Route fixture");
  assert.equal(JSON.stringify(listed).includes(tokens.access_token), false);
  const id = listed.connections[0].id;
  const note = await createNote({ title: "Allowlisted", body: "Body" });
  assert.equal((await request(allowedNotes, "PATCH", session.token, { allowedNoteIds: [note.id] }, { params: { id } })).status, 200);
  assert.deepEqual((await authenticate(tokens.access_token)).allowedNoteIds, [note.id]);
  assert.equal((await request(revoke, "DELETE", "missing", undefined, { params: { id } })).status, 401);
  assert.equal((await request(revoke, "DELETE", session.token, undefined,
    { params: { id }, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await request(revoke, "DELETE", session.token, undefined, { params: { id } })).status, 200);
  await assert.rejects(() => authenticate(tokens.access_token), { code: "unauthorized" });
  const refreshed = await token(new Request(`${origin}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }),
  }));
  assert.equal(refreshed.status, 400);
  console.log(JSON.stringify({ mode, consent: true, csrf: true, settings: true }));
} finally {
  if (mode === "sqlite") await closeSQLiteStore();
  else await closeDb();
  await rm(directory, { recursive: true, force: true });
}
