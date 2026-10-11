import { expect, test } from "bun:test";
import { sqliteTimestamp } from "@/server/db/sqlite";
import { closeSQLiteStore } from "@/server/db/backend";
import { createSQLiteNote, getSQLiteNote } from "@/server/notes/sqlite";
import { captureInbox, discardInbox, getInboxItem, listInbox, promoteInbox } from "./service";
import { mergeInbox, restoreInbox, snoozeInbox, unsnoozeInbox } from "./triage";
import { inboxFixture } from "./sqlite-test-fixture";

test("capture persists DTOs and legacy suggestions across file reopen", async () => {
  const f = await inboxFixture();
  try {
    const item = await captureInbox({ text: "  first line\nbody  ", source: "share" });
    f.store.run("UPDATE inbox_items SET suggestions=? WHERE id=?", [
      JSON.stringify({ tags: [{ tag: "idea", noul: 0.8 }, null],
        classification: { choice: "idea", probability: 0.7 } }), item.id]);
    const reader = f.fixture.open();
    expect(reader.get<{ body: string }>("SELECT body FROM inbox_items WHERE id=?", [item.id])?.body).toBe("first line\nbody");
    expect(await getInboxItem(item.id.toUpperCase())).toMatchObject({
      source: "share", title: "first line", suggestions: { status: "ready",
        tags: [{ tag: "idea", probability: 0.8 }], kind: { choice: "idea", confidence: 0.7 } },
    });
    reader.close();
    await closeSQLiteStore();
    expect((await getInboxItem(item.id))?.body).toBe("first line\nbody");
    expect(await getInboxItem(crypto.randomUUID())).toBeNull();
  } finally { await f.close(); }
});

test("capture validates source and empty input before persistence", async () => {
  const f = await inboxFixture();
  try {
    // The runtime API boundary must reject sources even when called without TypeScript.
    const input = JSON.parse('{"text":"capture","source":"invalid"}');
    await expect(captureInbox(input)).rejects.toMatchObject({ code: "validation" });
    await expect(captureInbox({ text: " " })).rejects.toMatchObject({ code: "validation" });
    expect((await listInbox()).count).toBe(0);
  } finally { await f.close(); }
});

test("snooze partitions views with stable ordering and next-return DTO", async () => {
  const f = await inboxFixture();
  try {
    const first = await captureInbox({ text: "first" });
    const second = await captureInbox({ text: "second" });
    const instant = sqliteTimestamp(new Date("2020-01-01T00:00:00Z"));
    f.store.run("UPDATE inbox_items SET created_at=?", [instant]);
    const until = new Date(Date.now() + 86400_000);
    await snoozeInbox(first.id, until);
    expect(await listInbox()).toMatchObject({ count: 1, snoozedCount: 1, nextReturnAt: until.toISOString() });
    expect((await listInbox("later")).items.map((item) => item.id)).toEqual([first.id]);
    expect((await listInbox()).items.map((item) => item.id)).toEqual([second.id]);
    await unsnoozeInbox(first.id);
    expect((await listInbox()).items.map((item) => item.id)).toEqual([first.id, second.id].sort().reverse());
    f.store.run("UPDATE inbox_items SET snoozed_until=? WHERE id=?", [instant, first.id]);
    expect(await listInbox("later")).toMatchObject({ count: 0, snoozedCount: 0, nextReturnAt: null });
  } finally { await f.close(); }
});

test.each(["2026-09-29T23:59:59Z", "2027-09-30T00:00:01Z"])("snooze rejects out of range time %s", async (until) => {
  const f = await inboxFixture();
  try {
    const item = await captureInbox({ text: "time" });
    await expect(snoozeInbox(item.id, new Date(until), new Date("2026-09-30T00:00:00Z")))
      .rejects.toMatchObject({ code: "validation" });
    expect((await getInboxItem(item.id))?.snoozedUntil).toBeNull();
  } finally { await f.close(); }
});

test("discard is idempotent and restore retains snooze", async () => {
  const f = await inboxFixture();
  try {
    const item = await captureInbox({ text: "discard" });
    const until = new Date("2027-09-30T00:00:00Z");
    await snoozeInbox(item.id, until, new Date("2026-09-30T00:00:00Z"));
    await discardInbox(item.id);
    const discarded = f.store.get<{ discarded_at: string }>("SELECT discarded_at FROM inbox_items WHERE id=?", [item.id]);
    await discardInbox(item.id);
    expect(f.store.get("SELECT discarded_at FROM inbox_items WHERE id=?", [item.id])).toEqual(discarded);
    await expect(promoteInbox(item.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(snoozeInbox(item.id, new Date(Date.now() + 86400_000))).rejects.toMatchObject({ code: "conflict" });
    expect((await restoreInbox(item.id)).snoozedUntil).toBe(until.toISOString());
    expect((await listInbox("later")).count).toBe(1);
  } finally { await f.close(); }
});

test("repeated concurrent promotion creates one note with links and transfers attachments", async () => {
  const f = await inboxFixture();
  try {
    const target = f.store.transaction((q) => createSQLiteNote(q, { title: "Target" }));
    const item = await captureInbox({ title: "Promoted", text: "[[Target]] #inline", url: "https://example.com" });
    f.store.run("INSERT INTO attachments(inbox_item_id,filename,mime,size_bytes,storage_key) VALUES (?,'clip','text/plain',4,'clip')", [item.id]);
    const [first, second] = await Promise.all([promoteInbox(item.id), promoteInbox(item.id.toUpperCase(), { title: "ignored" })]);
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({ body: "[[Target]] #inline", sourceUrl: "https://example.com", tags: ["inline"] });
    expect(f.store.get<{ count: bigint }>("SELECT count(*) AS count FROM notes")?.count).toBe(2n);
    expect(f.store.get("SELECT from_note_id,to_note_id FROM links")).toEqual({ from_note_id: first.id, to_note_id: target.id });
    expect(f.store.get("SELECT note_id,inbox_item_id FROM attachments")).toEqual({ note_id: first.id, inbox_item_id: null });
    await expect(restoreInbox(item.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(discardInbox(item.id)).rejects.toMatchObject({ code: "conflict" });
  } finally { await f.close(); }
});

test("promotion never applies proposed tags and strips legacy URL status", async () => {
  const f = await inboxFixture();
  try {
    const item = await captureInbox({ text: "keep" });
    f.store.run("UPDATE inbox_items SET body=?,suggestions=? WHERE id=?", [
      "keep\n\n> URL 내용을 가져오지 못했습니다. 원문 링크는 보존되었습니다.",
      JSON.stringify({ tags: [{ tag: "idea", probability: 0.99 }] }), item.id]);
    expect(await promoteInbox(item.id)).toMatchObject({ body: "keep", tags: [] });
  } finally { await f.close(); }
});

test("a competing writer fails promotion without partial changes and retry is idempotent", async () => {
  const f = await inboxFixture();
  const writer = f.fixture.raw();
  try {
    const item = await captureInbox({ text: "contended" });
    writer.run("BEGIN IMMEDIATE");
    try {
      await expect(promoteInbox(item.id)).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    } finally { writer.run("ROLLBACK"); }
    expect(f.store.get<{ count: bigint }>("SELECT count(*) AS count FROM notes")?.count).toBe(0n);
    expect((await listInbox()).count).toBe(1);
    const promoted = await promoteInbox(item.id);
    expect((await promoteInbox(item.id)).id).toBe(promoted.id);
  } finally { await f.close(); }
});

test("promotion rolls back note links and ownership when attachment transfer fails", async () => {
  const f = await inboxFixture();
  try {
    const item = await captureInbox({ text: "[[missing]]" });
    f.store.run("INSERT INTO attachments(inbox_item_id,filename,mime,size_bytes,storage_key) VALUES (?,'clip','text/plain',4,'clip')", [item.id]);
    f.fixture.raw().run("CREATE TRIGGER fail_transfer BEFORE UPDATE ON attachments BEGIN SELECT RAISE(ABORT,'transfer failed'); END");
    await expect(promoteInbox(item.id)).rejects.toThrow("transfer failed");
    expect(f.store.get<{ count: bigint }>("SELECT count(*) AS count FROM notes")?.count).toBe(0n);
    expect(f.store.get<{ count: bigint }>("SELECT count(*) AS count FROM unresolved_links")?.count).toBe(0n);
    expect(f.store.get("SELECT note_id,inbox_item_id FROM attachments")).toEqual({ note_id: null, inbox_item_id: item.id });
    expect((await listInbox()).count).toBe(1);
  } finally { await f.close(); }
});

test("merge appends content materializes links and records a revision atomically", async () => {
  const f = await inboxFixture();
  try {
    const target = f.store.transaction((q) => createSQLiteNote(q, { title: "Target", body: "base\n" }));
    const linked = f.store.transaction((q) => createSQLiteNote(q, { title: "Linked" }));
    const item = await captureInbox({ text: "[[Linked]]", url: "https://example.com" });
    await snoozeInbox(item.id, new Date(Date.now() + 86400_000));
    f.store.run("INSERT INTO attachments(inbox_item_id,filename,mime,size_bytes,storage_key) VALUES (?,'clip','text/plain',4,'clip')", [item.id]);
    const merged = await mergeInbox(item.id, { noteId: target.id.toUpperCase(), expectedUpdatedAt: target.updatedAt });
    expect(merged.body).toBe("base\n\n---\n\n[[Linked]]\n\nhttps://example.com");
    expect(f.store.get("SELECT reason,body FROM note_revisions")).toEqual({ reason: "merge", body: "base\n" });
    expect(f.store.get("SELECT from_note_id,to_note_id FROM links")).toEqual({ from_note_id: target.id, to_note_id: linked.id });
    expect(f.store.get("SELECT note_id,inbox_item_id FROM attachments")).toEqual({ note_id: target.id, inbox_item_id: null });
    expect((await getInboxItem(item.id))?.snoozedUntil).toBeNull();
    expect((await listInbox("later")).count).toBe(0);
    await expect(mergeInbox(item.id, { noteId: target.id })).rejects.toMatchObject({ code: "conflict" });
  } finally { await f.close(); }
});

test("stale merge leaves note item attachments and revisions unchanged", async () => {
  const f = await inboxFixture();
  try {
    const note = f.store.transaction((q) => createSQLiteNote(q, { body: "base" }));
    const item = await captureInbox({ text: "append" });
    await expect(mergeInbox(item.id, { noteId: note.id, expectedUpdatedAt: "2020-01-01T00:00:00Z" }))
      .rejects.toMatchObject({ code: "conflict", extra: { conflict: "stale" } });
    expect(getSQLiteNote(f.store, note.id)?.body).toBe("base");
    expect(f.store.get<{ count: bigint }>("SELECT count(*) AS count FROM note_revisions")?.count).toBe(0n);
    expect((await listInbox()).items.map((row) => row.id)).toEqual([item.id]);
  } finally { await f.close(); }
});

test("merge rolls back body revisions links and attachments when closing fails", async () => {
  const f = await inboxFixture();
  try {
    const note = f.store.transaction((q) => createSQLiteNote(q, { body: "base" }));
    const item = await captureInbox({ text: "[[missing]]" });
    f.store.run("INSERT INTO attachments(inbox_item_id,filename,mime,size_bytes,storage_key) VALUES (?,'clip','text/plain',4,'clip')", [item.id]);
    f.fixture.raw().run("CREATE TRIGGER fail_close BEFORE UPDATE OF promoted_note_id ON inbox_items BEGIN SELECT RAISE(ABORT,'close failed'); END");
    await expect(mergeInbox(item.id, { noteId: note.id })).rejects.toThrow("close failed");
    expect(getSQLiteNote(f.store, note.id)?.body).toBe("base");
    expect(f.store.get<{ count: bigint }>("SELECT count(*) AS count FROM note_revisions")?.count).toBe(0n);
    expect(f.store.get<{ count: bigint }>("SELECT count(*) AS count FROM unresolved_links")?.count).toBe(0n);
    expect(f.store.get("SELECT note_id,inbox_item_id FROM attachments")).toEqual({ note_id: null, inbox_item_id: item.id });
    expect((await listInbox()).count).toBe(1);
  } finally { await f.close(); }
});

test("merge rejects missing trashed and discarded targets without closing inbox", async () => {
  const f = await inboxFixture();
  try {
    const note = f.store.transaction((q) => createSQLiteNote(q, {}));
    const item = await captureInbox({ text: "append" });
    await expect(mergeInbox(item.id, { noteId: crypto.randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    f.store.run("UPDATE notes SET deleted_at=? WHERE id=?", [sqliteTimestamp(new Date()), note.id]);
    await expect(mergeInbox(item.id, { noteId: note.id })).rejects.toMatchObject({ code: "conflict" });
    await discardInbox(item.id);
    await expect(mergeInbox(item.id, { noteId: note.id })).rejects.toMatchObject({ code: "conflict" });
    expect(f.store.get("SELECT promoted_note_id FROM inbox_items WHERE id=?", [item.id])).toEqual({ promoted_note_id: null });
  } finally { await f.close(); }
});
