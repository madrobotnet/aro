import { expect, test } from "bun:test";
import { captureInbox, listInbox } from "./service";
import { inboxFixture } from "./sqlite-test-fixture";
import { closeSQLiteStore } from "@/server/db/backend";

test("committed replay after response loss survives reopen and inbox deletion", async () => {
  const f = await inboxFixture();
  try {
    const replay = { requestId: crypto.randomUUID(), ownerId: crypto.randomUUID() };
    const input = { text: "  immutable raw content  ", title: "title", url: "https://example.com" };
    const first = await captureInbox(input, "en", replay);
    f.store.run("DELETE FROM inbox_items WHERE id=?", [first.id]);
    await closeSQLiteStore();
    expect(await captureInbox(input, "ko", replay)).toEqual(first);
    expect((await listInbox()).count).toBe(0);
  } finally { await f.close(); }
});

test("concurrent identical capture attempts commit one inbox item and outcome", async () => {
  const f = await inboxFixture();
  try {
    const replay = { requestId: crypto.randomUUID(), ownerId: crypto.randomUUID() };
    const [first, second] = await Promise.all([
      captureInbox({ text: "one" }, "en", replay), captureInbox({ text: "one" }, "en", replay),
    ]);
    expect(first).toEqual(second);
    expect((await listInbox()).count).toBe(1);
    expect(f.store.get("SELECT count(*) AS total FROM capture_requests")).toEqual({ total: 1n });
  } finally { await f.close(); }
});

test("replay rejects changed raw content and owner without another insert", async () => {
  const f = await inboxFixture();
  try {
    const replay = { requestId: crypto.randomUUID(), ownerId: crypto.randomUUID() };
    await captureInbox({ text: "original" }, "en", replay);
    await expect(captureInbox({ text: " original " }, "en", replay)).rejects.toMatchObject({ code: "conflict" });
    await expect(captureInbox({ text: "original" }, "en", { ...replay, ownerId: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: "conflict" });
    expect((await listInbox()).count).toBe(1);
  } finally { await f.close(); }
});

test("outcome persistence failure atomically rolls back inbox creation", async () => {
  const f = await inboxFixture();
  try {
    f.fixture.raw().run("CREATE TRIGGER fail_capture BEFORE INSERT ON capture_requests BEGIN SELECT RAISE(ABORT,'outcome failed'); END");
    await expect(captureInbox({ text: "rollback" }, "en", {
      requestId: crypto.randomUUID(), ownerId: crypto.randomUUID(),
    })).rejects.toThrow("outcome failed");
    expect((await listInbox()).count).toBe(0);
    expect(f.store.get("SELECT count(*) AS total FROM capture_requests")).toEqual({ total: 0n });
  } finally { await f.close(); }
});
