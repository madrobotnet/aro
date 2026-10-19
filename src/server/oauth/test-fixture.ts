import { afterAll, afterEach, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { POST as register } from "@/app/oauth/register/route";
import { POST as token } from "@/app/oauth/token/route";
import { db } from "@/server/db";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { SQLiteFixture } from "@/server/db/sqlite/test-fixture";
import { closeDb, connectTestDatabase, resetData } from "@/server/test/db";
import { approve, validateAuthorization } from "./service";
import type { AgentScope } from "@/lib/agent-access";

export const ORIGIN = "http://localhost:3000";
export const RESOURCE = `${ORIGIN}/api/mcp`;
export const REDIRECT = "https://chatgpt.com/connector/callback";
export const VERIFIER = "a".repeat(43);
export const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
export const Tokens = z.object({
  access_token: z.string(), token_type: z.literal("Bearer"), expires_in: z.number(),
  refresh_token: z.string(), scope: z.string(),
});
const Client = z.object({ client_id: z.string(), client_secret: z.string().optional(), token_endpoint_auth_method: z.string() });
export type TestClient = z.infer<typeof Client>;
export function form(path: string, values: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(values) });
}
export async function registration(extra: Record<string, unknown> = {}) {
  return register(new Request(`${ORIGIN}/oauth/register`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Fixture connector", redirect_uris: [REDIRECT], ...extra }) }));
}
export async function client(extra: Record<string, unknown> = {}): Promise<TestClient> {
  const response = await registration(extra);
  if (response.status !== 201) throw new Error(`Registration failed: ${await response.text()}`);
  return Client.parse(await response.json());
}
export function authorizationParams(clientId: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: CHALLENGE, code_challenge_method: "S256", state: "client state + / & ?",
    resource: RESOURCE, scope: "read capture propose-write", ...extra });
}
export async function code(ownerId: string, registered: TestClient, scopes: readonly AgentScope[] = ["read", "capture"]) {
  const auth = await validateAuthorization(authorizationParams(registered.client_id), RESOURCE);
  return approve(auth, ownerId, scopes);
}
export async function exchange(registered: TestClient, authorizationCode: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return token(form("/oauth/token", { grant_type: "authorization_code", client_id: registered.client_id,
    code: authorizationCode, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE, ...extra }, headers));
}
export async function refresh(registered: TestClient, refreshToken: string, extra: Record<string, string> = {}) {
  return token(form("/oauth/token", { grant_type: "refresh_token", client_id: registered.client_id,
    refresh_token: refreshToken, resource: RESOURCE, ...extra }));
}
export function rpc(secret: string, method = "tools/list", params?: unknown): Request {
  return new Request(RESOURCE, { method: "POST", headers: {
    authorization: `Bearer ${secret}`, "content-type": "application/json", "mcp-protocol-version": "2025-06-18",
    accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}
export function oauthFixture(mode: "sqlite" | "postgres") {
  let fixture: SQLiteFixture | undefined;
  let ownerId = "";
  let prior: Record<string, string | undefined> = {};
  async function execute(pg: string, sqlite: string, params: string[] = []) {
    if (mode === "postgres") await (await db()).query(pg, params);
    else (await sqliteStore()).run(sqlite, params);
  }
  beforeEach(async () => {
    prior = Object.fromEntries(["ARO_DATABASE_MODE", "ARO_SQLITE_PATH", "DATABASE_URL", "ARO_MCP_ALLOWED_HOSTS"].map(key => [key, process.env[key]]));
    process.env.ARO_DATABASE_MODE = mode;
    delete process.env.ARO_MCP_ALLOWED_HOSTS;
    if (mode === "postgres") { connectTestDatabase(); await resetData(); }
    else { fixture = new SQLiteFixture(); process.env.ARO_SQLITE_PATH = fixture.filename; }
    ownerId = crypto.randomUUID();
    await execute("INSERT INTO users(id,password_hash) VALUES ($1,'fixture')", "INSERT INTO users(id,password_hash) VALUES (?,'fixture')", [ownerId]);
  });
  afterEach(async () => {
    if (mode === "sqlite") { await closeSQLiteStore(); fixture?.[Symbol.dispose](); }
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  afterAll(async () => { if (mode === "postgres") await closeDb(); });
  return { owner: () => ownerId, execute,
    async stored() {
      if (mode === "postgres") {
        const q = await db();
        return JSON.stringify((await Promise.all(["oauth_clients", "oauth_codes", "oauth_refresh_tokens", "agent_tokens"]
          .map(table => q.query(`SELECT * FROM ${table}`)))).map(result => result.rows));
      }
      const q = await sqliteStore();
      return JSON.stringify(["oauth_clients", "oauth_codes", "oauth_refresh_tokens", "agent_tokens"].map(table => q.all(`SELECT * FROM ${table}`)));
    },
  };
}
