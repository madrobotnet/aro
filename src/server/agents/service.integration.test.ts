import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { AgentToolCallSchema, CreateAgentTokenSchema } from "@/lib/agent-access";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { db } from "@/server/db";
import { SQLiteFixture } from "@/server/db/sqlite/test-fixture";
import { closeDb, connectTestDatabase, resetData, TEST_DATABASE_URL } from "@/server/test/db";
import { createNote, getNote, updateNote } from "@/server/notes/service";
import { createSession } from "@/server/auth/session";
import { authenticate, callTool, createToken, listActivity, listProposals, listTokens, reviewProposal, revokeToken } from "./service";
import { listedTools, MAX_AGENT_BODY_BYTES, mcpNoStream, mcpPost, readAgentJson, validateMcpOrigin } from "./transport";

const pg = process.env.ARO_AGENT_TEST_POSTGRES === "1";
const previous = {
  mode: process.env.ARO_DATABASE_MODE, path: process.env.ARO_SQLITE_PATH,
  database: process.env.DATABASE_URL, hosts: process.env.ARO_MCP_ALLOWED_HOSTS,
};
let fixture: SQLiteFixture | undefined;
let noteId = "";
let otherId = "";
const Detail = z.object({ id: z.string(), body: z.string(), version: z.string(), nextOffset: z.number().nullable() });
const Capture = z.object({ inboxItemId: z.string() });
const Proposal = z.object({ proposalId: z.string(), status: z.string() });
function tool(name: string, args: Record<string, unknown>) {
  return AgentToolCallSchema.parse({ name, arguments: args });
}
async function reader() { return createToken(CreateAgentTokenSchema.parse({ name: "Reader" })); }
async function writer() {
  return createToken(CreateAgentTokenSchema.parse({ name: "Writer", scopes: ["read", "capture", "propose-write"], allowedNoteIds: [noteId] }));
}
async function detail(secret: string, id = noteId) {
  return Detail.parse(await callTool(secret, tool("get_note", { noteId: id })));
}
async function proposal(secret: string, patch = { body: "approved body [[Other]] #approved" }) {
  const current = await detail(secret);
  return Proposal.parse(await callTool(secret, tool("propose_note_update", {
    requestId: crypto.randomUUID(), noteId, expectedVersion: current.version, patch,
  })));
}
async function count(table: string): Promise<number> {
  // Only repository-owned table names, never external input.
  if (pg) return Number((await (await db()).query<{ total: string }>(`SELECT count(*) AS total FROM ${table}`)).rows[0]?.total ?? 0);
  return Number((await sqliteStore()).get<{ total: bigint }>(`SELECT count(*) AS total FROM ${table}`)?.total ?? 0n);
}
async function execute(postgresSql: string, sqliteSql: string, params: string[] = []): Promise<void> {
  if (pg) await (await db()).query(postgresSql, params);
  else (await sqliteStore()).run(sqliteSql, params);
}
function rpc(secret: string, method: string, params?: unknown, headers: Record<string, string> = {}, id: string | number | undefined = 1) {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST", headers: {
      authorization: `Bearer ${secret}`, accept: "application/json, text/event-stream",
      "content-type": "application/json", "mcp-protocol-version": "2025-06-18", ...headers,
    }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
  });
}
beforeAll(() => {
  if (pg) {
    if (new URL(TEST_DATABASE_URL).pathname !== "/sb_test_aro_agents") throw new Error("Agent PG tests require their dedicated sb_test_aro_agents database");
    connectTestDatabase();
  }
});
beforeEach(async () => {
  delete process.env.ARO_MCP_ALLOWED_HOSTS;
  process.env.ARO_DATABASE_MODE = pg ? "postgres" : "sqlite";
  if (pg) await resetData();
  else {
    fixture = new SQLiteFixture();
    process.env.ARO_SQLITE_PATH = fixture.filename;
  }
  await execute("INSERT INTO users(password_hash) VALUES ('fixture')", "INSERT INTO users(password_hash) VALUES ('fixture')");
  noteId = (await createNote({ title: "Note", body: "original body", tags: ["original"] })).id;
  otherId = (await createNote({ title: "Other", body: "other secret" })).id;
});
afterEach(async () => {
  if (!pg) {
    await closeSQLiteStore();
    fixture?.[Symbol.dispose]();
    fixture = undefined;
  }
});
afterAll(async () => {
  if (pg) await closeDb();
  for (const [key, value] of Object.entries({
    ARO_DATABASE_MODE: previous.mode, ARO_SQLITE_PATH: previous.path,
    DATABASE_URL: previous.database, ARO_MCP_ALLOWED_HOSTS: previous.hosts,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe(`bounded agent backend (${pg ? "PostgreSQL" : "SQLite"})`, () => {
  test("distinct hashed tokens default to read and never return secrets on listing", async () => {
    const first = await reader();
    const second = await reader();
    expect(first.secret).not.toBe(second.secret);
    expect(first.token.scopes).toEqual(["read"]);
    expect(await authenticate(first.secret)).toEqual(first.token);
    const tokens = await listTokens();
    expect(tokens).toHaveLength(2);
    expect(JSON.stringify(tokens)).not.toContain(first.secret);
    const stored = pg
      ? (await (await db()).query<{ token_hash: string }>("SELECT token_hash FROM agent_tokens WHERE id=$1", [first.token.id])).rows[0]
      : (await sqliteStore()).get<{ token_hash: string }>("SELECT token_hash FROM agent_tokens WHERE id=?", [first.token.id]);
    expect(stored?.token_hash).toHaveLength(64);
    expect(stored?.token_hash).not.toBe(first.secret);
  });
  test("browser session tokens cannot authenticate as agent tokens", async () => {
    const session = await createSession({ passwordHash: "fixture", userAgent: null, ip: null });
    await expect(authenticate(session.token)).rejects.toMatchObject({ code: "unauthorized" });
  });
  test("scope omissions both hide tools and deny valid invocations", async () => {
    const token = await reader();
    expect(listedTools(token.token.scopes).map((t) => t.name)).toEqual(["search_notes", "get_note"]);
    await expect(callTool(token.secret, tool("capture_inbox", { requestId: crypto.randomUUID(), text: "private capture" })))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(await count("inbox_items")).toBe(0);
    expect((await listActivity(10))[0]?.status).toBe("denied");
  });
  test("capture-only scope does not imply read or propose access", async () => {
    const token = await createToken(CreateAgentTokenSchema.parse({ name: "Capture", scopes: ["capture"] }));
    expect(listedTools(token.token.scopes).map((t) => t.name)).toEqual(["capture_inbox"]);
    await expect(detail(token.secret)).rejects.toMatchObject({ code: "forbidden" });
  });
  test("write grants require explicit existing notes and reject extra creation fields", async () => {
    expect(CreateAgentTokenSchema.safeParse({ name: "bad", scopes: ["propose-write"] }).success).toBe(false);
    expect(CreateAgentTokenSchema.safeParse({ name: "bad", scopes: ["read"], allowedNoteIds: [noteId] }).success).toBe(false);
    await expect(createToken(CreateAgentTokenSchema.parse({ name: "bad", scopes: ["propose-write"], allowedNoteIds: [crypto.randomUUID()] })))
      .rejects.toMatchObject({ code: "not_found" });
    expect(AgentToolCallSchema.safeParse({ name: "propose_note_update", arguments: {
      requestId: crypto.randomUUID(), noteId, expectedVersion: "a".repeat(64), patch: { body: "new", create: true },
    } }).success).toBe(false);
  });
  test("read slices and search results are bounded without writing or enrichment", async () => {
    await updateNote(noteId, { body: "bounded".repeat(5000) });
    const token = await reader();
    const got = await detail(token.secret);
    expect(got.body).toHaveLength(16000);
    expect(got.nextOffset).toBe(16000);
    const page = Detail.parse(await callTool(token.secret, tool("get_note", { noteId, offset: 16000, limit: 100 })));
    expect(page.body).toHaveLength(100);
    expect(page.version).toBe(got.version);
    const search = z.object({ notes: z.array(z.object({ id: z.string(), excerpt: z.string() })) }).parse(
      await callTool(token.secret, tool("search_notes", { query: "bounded", limit: 1 })));
    expect(search.notes.map((n) => n.id)).toEqual([noteId]);
    expect(search.notes[0]?.excerpt.length).toBeLessThanOrEqual(300);
    expect(await count("notes")).toBe(2);
    expect(await count("inbox_items")).toBe(0);
  });
  test("trashed notes are unreadable and cannot receive proposals", async () => {
    const token = await writer();
    const version = (await detail(token.secret)).version;
    await execute("UPDATE notes SET deleted_at=now() WHERE id=$1",
      "UPDATE notes SET deleted_at='2026-10-11T00:00:00.000000Z' WHERE id=?", [noteId]);
    await expect(detail(token.secret)).rejects.toMatchObject({ code: "not_found" });
    await expect(callTool(token.secret, tool("propose_note_update", {
      requestId: crypto.randomUUID(), noteId, expectedVersion: version, patch: { body: "new" },
    }))).rejects.toMatchObject({ code: "not_found" });
  });
  test("concurrent identical captures commit only one raw inbox entry", async () => {
    const token = await writer();
    const call = tool("capture_inbox", { requestId: crypto.randomUUID(), title: "Raw", text: "https://example.invalid\nprivate capture" });
    const [first, second] = await Promise.all([callTool(token.secret, call), callTool(token.secret, call)]);
    expect(first).toEqual(second);
    const item = Capture.parse(first);
    expect(await count("inbox_items")).toBe(1);
    expect(await count("notes")).toBe(2);
    const stored = pg
      ? (await (await db()).query<{ body: string; url: string | null; suggestions: unknown }>("SELECT body,url,suggestions FROM inbox_items WHERE id=$1", [item.inboxItemId])).rows[0]
      : (await sqliteStore()).get<{ body: string; url: string | null; suggestions: unknown }>("SELECT body,url,suggestions FROM inbox_items WHERE id=?", [item.inboxItemId]);
    expect(stored).toEqual({ body: "https://example.invalid\nprivate capture", url: null, suggestions: null });
  });
  test("capture replay survives deletion and rejects changed content", async () => {
    const token = await writer();
    const requestId = crypto.randomUUID();
    const call = tool("capture_inbox", { requestId, text: "raw" });
    const result = Capture.parse(await callTool(token.secret, call));
    await execute("DELETE FROM inbox_items WHERE id=$1", "DELETE FROM inbox_items WHERE id=?", [result.inboxItemId]);
    expect(await callTool(token.secret, call)).toEqual(result);
    expect((await listActivity(100)).filter((entry) => entry.tool === "capture_inbox" && entry.status === "ok")
      .map((entry) => entry.targetId)).toEqual([result.inboxItemId, result.inboxItemId]);
    await expect(callTool(token.secret, tool("capture_inbox", { requestId, text: " raw " })))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await count("inbox_items")).toBe(0);
  });
  test("proposal allowlist prevents updates to another note", async () => {
    const token = await writer();
    const current = await detail(token.secret, otherId);
    await expect(callTool(token.secret, tool("propose_note_update", {
      requestId: crypto.randomUUID(), noteId: otherId, expectedVersion: current.version, patch: { body: "changed" },
    }))).rejects.toMatchObject({ code: "forbidden" });
    expect(await count("agent_proposals")).toBe(0);
  });
  test("proposal-only token can propose a known version without a read grant", async () => {
    const read = await reader();
    const version = (await detail(read.secret)).version;
    const token = await createToken(CreateAgentTokenSchema.parse({ name: "Propose", scopes: ["propose-write"], allowedNoteIds: [noteId] }));
    expect(listedTools(token.token.scopes).map((t) => t.name)).toEqual(["propose_note_update"]);
    const result = Proposal.parse(await callTool(token.secret, tool("propose_note_update", {
      requestId: crypto.randomUUID(), noteId, expectedVersion: version, patch: { body: "proposed" },
    })));
    expect(result.status).toBe("pending");
    expect((await getNote(noteId))?.body).toBe("original body");
  });
  test("proposal replay is content-bound and never applies a note update", async () => {
    const token = await writer();
    const version = (await detail(token.secret)).version;
    const requestId = crypto.randomUUID();
    const args = { requestId, noteId, expectedVersion: version, patch: { body: "pending secret" } };
    const call = tool("propose_note_update", args);
    const [first, second] = await Promise.all([callTool(token.secret, call), callTool(token.secret, call)]);
    expect(first).toEqual(second);
    await expect(callTool(token.secret, tool("propose_note_update", { ...args, patch: { body: "changed" } })))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await count("agent_proposals")).toBe(1);
    expect((await getNote(noteId))?.body).toBe("original body");
  });
  test("approval atomically records revision links and status, once under concurrent review", async () => {
    const token = await writer();
    const proposed = await proposal(token.secret);
    const [first, second] = await Promise.all([
      reviewProposal(proposed.proposalId, "approved"), reviewProposal(proposed.proposalId, "approved"),
    ]);
    expect(first).toEqual(second);
    expect(first.status).toBe("approved");
    expect((await getNote(noteId))?.body).toBe("approved body [[Other]] #approved");
    expect(await count("note_revisions")).toBe(1);
    expect(await count("links")).toBe(1);
    expect((await getNote(noteId))?.tags).toContain("approved");
    await expect(reviewProposal(proposed.proposalId, "rejected")).rejects.toMatchObject({ code: "conflict" });
  });
  test("stale approval leaves the note and pending proposal untouched", async () => {
    const token = await writer();
    const proposed = await proposal(token.secret);
    await updateNote(noteId, { body: "owner edit" });
    await expect(reviewProposal(proposed.proposalId, "approved")).rejects.toMatchObject({ code: "conflict" });
    expect((await getNote(noteId))?.body).toBe("owner edit");
    expect((await listProposals("pending", 10))[0]?.id).toBe(proposed.proposalId);
  });
  test("revocation denies the next tool call and pending approval", async () => {
    const token = await writer();
    const proposed = await proposal(token.secret);
    await revokeToken(token.token.id);
    await revokeToken(token.token.id);
    await expect(authenticate(token.secret)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(detail(token.secret)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(reviewProposal(proposed.proposalId, "approved")).rejects.toMatchObject({ code: "forbidden" });
    expect((await getNote(noteId))?.body).toBe("original body");
    // Owner may clear revoked or stale requests without granting new access.
    expect((await reviewProposal(proposed.proposalId, "rejected")).status).toBe("rejected");
  });
  test("approval rechecks scope and allowlist from the database", async () => {
    const token = await writer();
    const proposed = await proposal(token.secret);
    await execute("UPDATE agent_tokens SET allowed_note_ids='[]' WHERE id=$1",
      "UPDATE agent_tokens SET allowed_note_ids='[]' WHERE id=?", [token.token.id]);
    await expect(reviewProposal(proposed.proposalId, "approved")).rejects.toMatchObject({ code: "forbidden" });
    expect((await getNote(noteId))?.body).toBe("original body");
  });
  test("failed decision persistence rolls back note content and revision", async () => {
    const token = await writer();
    const proposed = await proposal(token.secret);
    if (pg) {
      await execute("CREATE FUNCTION fail_agent_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review failed'; END $$", "");
      await execute("CREATE TRIGGER fail_review BEFORE UPDATE ON agent_proposals FOR EACH ROW EXECUTE FUNCTION fail_agent_review()", "");
    } else {
      fixture?.raw().run("CREATE TRIGGER fail_review BEFORE UPDATE ON agent_proposals BEGIN SELECT RAISE(ABORT,'review failed'); END");
    }
    try {
      await expect(reviewProposal(proposed.proposalId, "approved")).rejects.toThrow("review failed");
      expect((await getNote(noteId))?.body).toBe("original body");
      expect(await count("note_revisions")).toBe(0);
      expect(await count("links")).toBe(0);
      expect((await listProposals("pending", 10))[0]?.id).toBe(proposed.proposalId);
    } finally {
      if (pg) {
        await execute("DROP TRIGGER fail_review ON agent_proposals", "");
        await execute("DROP FUNCTION fail_agent_review()", "");
      } else fixture?.raw().run("DROP TRIGGER fail_review");
    }
  });
  test("rejection is idempotent and never changes note content", async () => {
    const token = await writer();
    const proposed = await proposal(token.secret);
    const first = await reviewProposal(proposed.proposalId, "rejected");
    expect(await reviewProposal(proposed.proposalId, "rejected")).toEqual(first);
    expect((await getNote(noteId))?.body).toBe("original body");
    expect(await count("note_revisions")).toBe(0);
  });
  test("activity contains only fixed metadata and UUID identities", async () => {
    const token = await writer();
    await callTool(token.secret, tool("search_notes", { query: "private prompt" }));
    await callTool(token.secret, tool("capture_inbox", { requestId: crypto.randomUUID(), text: "private body" }));
    const activity = await listActivity(100);
    expect(activity).toHaveLength(2);
    const serialized = JSON.stringify(activity);
    for (const value of [token.secret, "private prompt", "private body"]) expect(serialized).not.toContain(value);
    for (const row of activity) expect(Object.keys(row).sort()).toEqual(["createdAt", "id", "status", "targetId", "tokenId", "tool"]);
  });
  test("tool rate limit is enforced from shared database state", async () => {
    const token = await reader();
    if (pg) await (await db()).query(`INSERT INTO agent_activity(id,token_id,tool,status)
      SELECT gen_random_uuid(),$1,'get_note','ok' FROM generate_series(1,120)`, [token.token.id]);
    else {
      const store = await sqliteStore();
      store.transaction((q) => {
        for (let i = 0; i < 120; i++) q.run("INSERT INTO agent_activity(token_id,tool,status) VALUES (?,'get_note','ok')", [token.token.id]);
      });
    }
    await expect(detail(token.secret)).rejects.toMatchObject({ code: "rate_limited" });
  });
  test("an already-authenticated independent process sees revocation on its next call", async () => {
    const token = await reader();
    const Reply = z.object({ ok: z.boolean(), code: z.string().optional() });
    let signal = Promise.withResolvers<z.infer<typeof Reply>>();
    const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./process-fixture.ts", import.meta.url))], {
      env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe",
      ipc(message) { signal.resolve(Reply.parse(message)); },
    });
    async function send(action: "authenticate" | "read") {
      signal = Promise.withResolvers<z.infer<typeof Reply>>();
      child.send({ action, secret: token.secret, noteId });
      return signal.promise;
    }
    try {
      expect((await send("authenticate")).ok).toBe(true);
      await revokeToken(token.token.id);
      expect(await send("read")).toEqual({ ok: false, code: "unauthorized" });
    } finally {
      child.kill();
      await child.exited;
    }
  });
  test("a failed replay insert rolls back its raw inbox capture", async () => {
    const token = await writer();
    if (pg) {
      await execute("CREATE FUNCTION fail_agent_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'request failed'; END $$", "");
      await execute("CREATE TRIGGER fail_request BEFORE INSERT ON agent_requests FOR EACH ROW EXECUTE FUNCTION fail_agent_request()", "");
    } else fixture?.raw().run("CREATE TRIGGER fail_request BEFORE INSERT ON agent_requests BEGIN SELECT RAISE(ABORT,'request failed'); END");
    try {
      await expect(callTool(token.secret, tool("capture_inbox", { requestId: crypto.randomUUID(), text: "rollback" })))
        .rejects.toThrow("request failed");
      expect(await count("inbox_items")).toBe(0);
      expect(await count("agent_requests")).toBe(0);
    } finally {
      if (pg) {
        await execute("DROP TRIGGER fail_request ON agent_requests", "");
        await execute("DROP FUNCTION fail_agent_request()", "");
      } else fixture?.raw().run("DROP TRIGGER fail_request");
    }
  });
});

describe("MCP Streamable HTTP boundaries", () => {
  test("initialize negotiates stable version and supports ping and schema-derived tools", async () => {
    const token = await reader();
    const init = rpc(token.secret, "initialize", { protocolVersion: "future", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
    init.headers.delete("mcp-protocol-version");
    const initialized = await mcpPost(init);
    expect(initialized.status).toBe(200);
    expect((await initialized.json()).result.protocolVersion).toBe("2025-06-18");
    expect((await (await mcpPost(rpc(token.secret, "ping"))).json()).result).toEqual({});
    const listed = await (await mcpPost(rpc(token.secret, "tools/list"))).json();
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(["search_notes", "get_note"]);
    expect(listed.result.tools[1].inputSchema.properties.noteId.format).toBe("uuid");
  });
  test("scope-denied tool invocation returns a tool error without mutation", async () => {
    const token = await reader();
    const output = await (await mcpPost(rpc(token.secret, "tools/call", {
      name: "capture_inbox", arguments: { requestId: crypto.randomUUID(), text: "denied" },
    }))).json();
    expect(output.result.isError).toBe(true);
    expect(JSON.parse(output.result.content[0].text).code).toBe("forbidden");
    expect(await count("inbox_items")).toBe(0);
  });
  test("valid read tools return structured content and compatible text", async () => {
    const token = await reader();
    const output = await (await mcpPost(rpc(token.secret, "tools/call", { name: "get_note", arguments: { noteId } }))).json();
    expect(output.result.isError).toBe(false);
    expect(output.result.structuredContent.body).toBe("original body");
    expect(JSON.parse(output.result.content[0].text)).toEqual(output.result.structuredContent);
  });
  test("notifications get empty 202 but cannot invoke tools", async () => {
    const token = await writer();
    for (const [method, params] of [
      ["notifications/initialized", {}], ["notifications/cancelled", { requestId: 2 }],
      ["notifications/progress", { progressToken: 2, progress: 1 }],
    ] as const) {
      const request = rpc(token.secret, method, params);
      const body = JSON.parse(await request.text());
      delete body.id;
      const notification = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) });
      const output = await mcpPost(notification);
      expect(output.status).toBe(202);
      expect(await output.text()).toBe("");
    }
    const request = rpc(token.secret, "tools/call", { name: "capture_inbox", arguments: { requestId: crypto.randomUUID(), text: "no ID" } });
    const body = JSON.parse(await request.text());
    delete body.id;
    expect((await mcpPost(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) }))).status).toBe(400);
    expect(await count("inbox_items")).toBe(0);
  });
  test("missing unsupported protocol and unacceptable media headers reject calls", async () => {
    const token = await reader();
    for (const version of [undefined, "2025-03-26", "draft"]) {
      const request = rpc(token.secret, "ping");
      if (version) request.headers.set("mcp-protocol-version", version);
      else request.headers.delete("mcp-protocol-version");
      expect((await mcpPost(request)).status).toBe(400);
    }
    for (const accept of ["application/json", "text/event-stream", "application/json, text/event-stream;q=0"]) {
      expect((await mcpPost(rpc(token.secret, "ping", {}, { accept }))).status).toBe(406);
    }
  });
  test("invalid arguments unknown methods batches and malformed JSON are rejected", async () => {
    const token = await reader();
    expect((await (await mcpPost(rpc(token.secret, "unknown"))).json()).error.code).toBe(-32601);
    expect((await (await mcpPost(rpc(token.secret, "tools/call", { name: "get_note", arguments: { noteId, body: "extra" } }))).json()).error.code).toBe(-32602);
    const request = rpc(token.secret, "ping");
    for (const body of ["{", "[]", '[{"jsonrpc":"2.0","id":1,"method":"ping"}]']) {
      expect((await mcpPost(new Request(request.url, { method: "POST", headers: request.headers, body }))).status).toBe(400);
    }
  });
  test("no bearer or browser cookies alone never grant access", async () => {
    const token = await reader();
    const request = rpc(token.secret, "ping");
    request.headers.delete("authorization");
    request.headers.set("cookie", `sb_session=${token.secret}`);
    const output = await mcpPost(request);
    expect(output.status).toBe(401);
    expect(output.headers.get("www-authenticate")).toBe('Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp", scope="read capture"');
  });
  test("loopback CLI requests need no Origin; malicious and rebound authorities fail", () => {
    expect(() => validateMcpOrigin(new Request("http://localhost:3000/api/mcp"))).not.toThrow();
    for (const request of [
      new Request("http://evil.example/api/mcp"),
      new Request("http://localhost:3000/api/mcp", { headers: { origin: "https://evil.example" } }),
      new Request("http://localhost:3000/api/mcp", { headers: { origin: "null" } }),
      new Request("http://localhost:3000/api/mcp", { headers: { host: "evil.example", "x-forwarded-host": "localhost:3000" } }),
      new Request("http://localhost:3000/api/mcp", { headers: { "sec-fetch-site": "cross-site" } }),
    ]) expect(() => validateMcpOrigin(request)).toThrow();
    process.env.ARO_MCP_ALLOWED_HOSTS = "aro.example";
    expect(() => validateMcpOrigin(new Request("https://aro.example/api/mcp", { headers: { origin: "https://aro.example" } }))).not.toThrow();
    expect(() => validateMcpOrigin(new Request("https://aro.example.evil/api/mcp"))).toThrow();
  });
  test("no SSE is advertised and GET challenges before an authenticated 405", async () => {
    const token = await reader();
    expect((await mcpNoStream(new Request("http://localhost:3000/api/mcp"))).status).toBe(401);
    expect((await mcpNoStream(new Request("http://localhost:3000/api/mcp", { headers: { authorization: `Bearer ${token.secret}` } }))).status).toBe(405);
    expect((await mcpNoStream(new Request("http://localhost:3000/api/mcp", { headers: { origin: "https://evil.example" } }))).status).toBe(403);
  });
  test("streamed bodies are bounded even with missing or forged Content-Length", async () => {
    const token = await reader();
    const headers = rpc(token.secret, "ping").headers;
    headers.set("content-length", "1");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_AGENT_BODY_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); },
    });
    const request = new Request("http://localhost:3000/api/mcp", { method: "POST", headers, body: stream });
    await expect(readAgentJson(request)).rejects.toMatchObject({ code: "payload_too_large" });
  });
});
