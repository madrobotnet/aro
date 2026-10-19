import { describe, expect, test } from "bun:test";
import { createNote } from "@/server/notes/service";
import { authenticate, listActivity } from "@/server/agents/service";
import { mcpPost } from "@/server/agents/transport";
import { listConnections, updateAllowedNotes } from "./service";
import { client, code, exchange, oauthFixture, refresh, RESOURCE, rpc, Tokens } from "./test-fixture";

for (const mode of ["sqlite", "postgres"] as const) describe(`OAuth permissions (${mode})`, () => {
  const fixture = oauthFixture(mode);

  test("read scope filters tools/list and denies capture through tools/call", async () => {
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app, ["read"]))).json());
    const listed = await (await mcpPost(rpc(issued.access_token))).json();
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_notes", "get_note"]);
    const denied = await (await mcpPost(rpc(issued.access_token, "tools/call", {
      name: "capture_inbox", arguments: { requestId: crypto.randomUUID(), text: "not allowed" },
    }))).json();
    expect(denied.result.isError).toBe(true);
    expect(JSON.parse(denied.result.content[0].text).code).toBe("forbidden");
    expect((await listActivity(10))[0]?.status).toBe("denied");
  });

  test("capture scope writes through the existing tool and activity model", async () => {
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app, ["capture"]))).json());
    const output = await (await mcpPost(rpc(issued.access_token, "tools/call", {
      name: "capture_inbox", arguments: { requestId: crypto.randomUUID(), text: "OAuth capture" },
    }))).json();
    expect(output.result.isError).toBe(false);
    expect(output.result.structuredContent.inboxItemId).toBeString();
    expect((await listActivity(10))[0]?.tool).toBe("capture_inbox");
    expect((await listConnections(fixture.owner()))[0]?.lastUsedAt).not.toBeNull();
  });

  test("proposal scope starts empty and settings allowlist applies to current and rotated tokens", async () => {
    const note = await createNote({ title: "Allowed", body: "Original" });
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app, ["read", "propose-write"]))).json());
    const detail = await (await mcpPost(rpc(issued.access_token, "tools/call", { name: "get_note", arguments: { noteId: note.id } }))).json();
    const proposal = { name: "propose_note_update", arguments: { requestId: crypto.randomUUID(),
      noteId: note.id, expectedVersion: detail.result.structuredContent.version, patch: { body: "Proposed" } } };
    expect((await (await mcpPost(rpc(issued.access_token, "tools/call", proposal))).json()).result.isError).toBe(true);
    const grant = (await listConnections(fixture.owner()))[0];
    if (!grant) throw new Error("Missing connection");
    await updateAllowedNotes(grant.id, fixture.owner(), { allowedNoteIds: [note.id] });
    expect((await (await mcpPost(rpc(issued.access_token, "tools/call", proposal))).json()).result.isError).toBe(false);
    const rotated = Tokens.parse(await (await refresh(app, issued.refresh_token)).json());
    expect((await authenticate(rotated.access_token)).allowedNoteIds).toEqual([note.id]);
  });

  test("refresh cannot expand scopes and a reduced scope stays reduced", async () => {
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app))).json());
    expect((await refresh(app, issued.refresh_token, { scope: "propose-write" })).status).toBe(400);
    const reduced = Tokens.parse(await (await refresh(app, issued.refresh_token, { scope: "read" })).json());
    expect(reduced.scope).toBe("read");
    const next = Tokens.parse(await (await refresh(app, reduced.refresh_token)).json());
    expect(next.scope).toBe("read");
    expect((await listConnections(fixture.owner()))[0]?.scopes).toEqual(["read"]);
  });

  test("an OAuth access token is bound to the originally approved MCP resource", async () => {
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app))).json());
    expect((await authenticate(issued.access_token)).resource).toBe(RESOURCE);
    process.env.ARO_MCP_ALLOWED_HOSTS = "other.example";
    const request = rpc(issued.access_token);
    request.headers.set("host", "other.example");
    expect((await mcpPost(request)).status).toBe(401);
  });
});
