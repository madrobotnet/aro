import { afterAll, expect, test } from "bun:test";
import { closeDb, connectTestDatabase } from "@/server/test/db";
import { query, queryOne, db } from "@/server/db";
import { captureInbox } from "./service";

connectTestDatabase();
afterAll(closeDb);

test("PostgreSQL concurrent replay binds raw content and owner and retains exact outcome", async () => {
  const replay = { requestId: crypto.randomUUID(), ownerId: crypto.randomUUID() };
  const input = { text: "exact capture", title: `offline-${replay.requestId}` };
  let itemId: string | undefined;
  try {
    const [first, second] = await Promise.all([
      captureInbox(input, "en", replay), captureInbox(input, "en", replay),
    ]);
    itemId = first.id;
    expect(second).toEqual(first);
    expect(await queryOne("SELECT count(*)::int AS total FROM inbox_items WHERE title=$1", [input.title]))
      .toEqual({ total: 1 });
    expect(await queryOne("SELECT count(*)::int AS total FROM capture_requests WHERE id=$1", [replay.requestId]))
      .toEqual({ total: 1 });
    await expect(captureInbox({ ...input, text: " exact capture " }, "en", replay)).rejects.toMatchObject({ code: "conflict" });
    await expect(captureInbox(input, "en", { ...replay, ownerId: crypto.randomUUID() })).rejects.toMatchObject({ code: "conflict" });
    await query("DELETE FROM inbox_items WHERE id=$1", [first.id]);
    expect(await captureInbox(input, "ko", replay)).toEqual(first);
  } finally {
    await query("DELETE FROM capture_requests WHERE id=$1", [replay.requestId]);
    if (itemId) await query("DELETE FROM inbox_items WHERE id=$1", [itemId]);
  }
});

test("PostgreSQL outcome failure rolls back inbox creation in the same transaction", async () => {
  // A request-specific trigger affects only this isolated test database and request.
  const replay = { requestId: crypto.randomUUID(), ownerId: crypto.randomUUID() };
  const name = `capture_fail_${replay.requestId.replaceAll("-", "")}`;
  const pool = await db();
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id = '${replay.requestId}'::uuid THEN RAISE EXCEPTION 'outcome failed'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON capture_requests FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  const title = `rollback-${replay.requestId}`;
  try {
    await expect(captureInbox({ text: "rollback", title }, "en", replay)).rejects.toThrow("outcome failed");
    expect(await queryOne("SELECT count(*)::int AS total FROM inbox_items WHERE title=$1", [title])).toEqual({ total: 0 });
    expect(await queryOne("SELECT count(*)::int AS total FROM capture_requests WHERE id=$1", [replay.requestId])).toEqual({ total: 0 });
  } finally {
    await pool.query(`DROP TRIGGER ${name} ON capture_requests`);
    await pool.query(`DROP FUNCTION ${name}()`);
  }
});
