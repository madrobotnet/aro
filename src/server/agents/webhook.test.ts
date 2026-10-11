import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { createToken, revokeToken } from "./service";
import { POST } from "@/app/api/webhooks/capture/route";

test("capture webhook requires scoped bearer, replays once and honors revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-webhook-"));
  const before = { ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE, ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH,
    ARO_MCP_ALLOWED_HOSTS: process.env.ARO_MCP_ALLOWED_HOSTS };
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "agents.sqlite");
  delete process.env.ARO_MCP_ALLOWED_HOSTS;
  const send = (secret: string | null, payload: unknown, origin?: string) => POST(new Request("http://127.0.0.1/api/webhooks/capture", {
    method: "POST", headers: { "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(payload),
  }));
  try {
    const store = await sqliteStore();
    store.run("INSERT INTO users(password_hash) VALUES (?)", ["fixture-only"]);
    const readOnly = await createToken({ name: "Read", scopes: ["read"], allowedNoteIds: [] });
    const capture = await createToken({ name: "Capture", scopes: ["capture"], allowedNoteIds: [] });
    const body = { requestId: crypto.randomUUID(), title: "Webhook proof", text: "No enrichment" };
    expect((await send(null, body)).status).toBe(401);
    expect((await send(readOnly.secret, body)).status).toBe(403);
    expect((await send(capture.secret, body, "https://different.example")).status).toBe(403);
    const first = await send(capture.secret, body);
    const replay = await send(capture.secret, body);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual(await replay.json());
    expect(store.get<{ count: bigint }>("SELECT count(*) AS count FROM inbox_items")?.count).toBe(1n);
    expect((await send(capture.secret, { ...body, text: "Changed" })).status).toBe(409);
    await revokeToken(capture.token.id);
    expect((await send(capture.secret, body)).status).toBe(401);
  } finally {
    await closeSQLiteStore();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
