import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, query, tx } from "@/server/db";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { createNote, getNote, purgeNote, restoreNote, trashNote, updateNote } from "@/server/notes/service";
import { createShare, listShares, readShare, revokeShare, shareInput } from "./service";

const pgUrl = process.env.SHARES_TEST_DATABASE_URL;
if (pgUrl && new URL(pgUrl).pathname !== "/sb_test_aro_shares") throw new Error("Shares tests require their isolated database");
const original = { ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE, ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH, DATABASE_URL: process.env.DATABASE_URL };
const now = new Date("2030-01-01T00:00:00.000Z");
for (const mode of ["sqlite", "postgres"] as const) {
  describe.skipIf(mode === "postgres" && !pgUrl)(`${mode} restricted snapshots`, () => {
    let directory: string;
    let ownerId: string;
    let noteId: string;
    beforeEach(async () => {
      await closeDb(); await closeSQLiteStore();
      directory = await mkdtemp(path.join(tmpdir(), "aro-shares-"));
      process.env.ARO_DATABASE_MODE = mode;
      process.env.ARO_SQLITE_PATH = path.join(directory, "shares.sqlite");
      if (pgUrl) process.env.DATABASE_URL = pgUrl;
      ownerId = randomUUID();
      if (mode === "sqlite") (await sqliteStore()).run("INSERT INTO users(id,password_hash) VALUES (?,'test')", [ownerId]);
      else await query("INSERT INTO users(id,password_hash) VALUES ($1,'test')", [ownerId]);
      noteId = (await createNote({ title: "Snapshot", body: "original" })).id;
    });
    afterEach(async () => {
      if (mode === "postgres") {
        await query("DELETE FROM notes WHERE id=$1", [noteId]);
        await query("DELETE FROM users WHERE id=$1", [ownerId]);
      }
      await closeDb(); await closeSQLiteStore();
      await rm(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const create = (hours = 24) => createShare({ noteId, ownerId, expiresInHours: hours, confirmed: true }, now);
    const tokenOf = (result: { path: string }) => result.path.slice("/share/".length);

    test("keeps a read-only saved snapshot when the original changes", async () => {
      // Given a snapshot of the original note.
      const shared = await create();
      // When the original is edited.
      await updateNote(noteId, { title: "Changed", body: "changed" });
      // Then the bearer reads only the original saved text.
      expect(await readShare(tokenOf(shared), now)).toEqual({ title: "Snapshot", body: "original", expiresAt: "2030-01-02T00:00:00.000Z" });
      expect((await getNote(noteId))?.body).toBe("changed");
    });
    test("stores only hashes and lists metadata without revealing bearer or content", async () => {
      // Given a saved note.
      // When two links are explicitly created.
      const first = await create(); const second = await create();
      // Then fresh 256-bit bearers are distinct and absent from persistence/listing.
      expect(tokenOf(first)).toMatch(/^[0-9a-f]{64}$/);
      expect(first.path).not.toBe(second.path);
      const stored = mode === "sqlite"
        ? (await sqliteStore()).get<{ token_hash: string }>("SELECT token_hash FROM note_shares WHERE id=?", [first.share.id])
        : (await query<{ token_hash: string }>("SELECT token_hash FROM note_shares WHERE id=$1", [first.share.id]))[0];
      expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored?.token_hash).not.toBe(tokenOf(first));
      const listed = await listShares(noteId, ownerId);
      expect(listed).toHaveLength(2);
      expect(Object.keys(listed[0] ?? {}).sort()).toEqual(["createdAt", "expiresAt", "id", "revokedAt"]);
    });
    test("denies expiry exactly at the injected boundary", async () => {
      // Given a one-day bearer valid one millisecond before expiry.
      const shared = await create();
      expect(await readShare(tokenOf(shared), new Date("2030-01-01T23:59:59.999Z"))).not.toBeNull();
      // When the clock reaches the expiry instant.
      const read = await readShare(tokenOf(shared), new Date("2030-01-02T00:00:00.000Z"));
      // Then access is denied, with no sleeps.
      expect(read).toBeNull();
    });
    test("denies a revoked link without changing the note", async () => {
      // Given a bearer.
      const shared = await create();
      // When the owner revokes it, including a repeated revoke.
      await revokeShare({ noteId, ownerId, shareId: shared.share.id }, now);
      await revokeShare({ noteId, ownerId, shareId: shared.share.id }, now);
      // Then it cannot read or write the private note.
      expect(await readShare(tokenOf(shared), now)).toBeNull();
      expect((await getNote(noteId))?.body).toBe("original");
    });
    for (const action of ["trash", "archive", "purge"] as const) {
      test(`denies ${action} immediately and never reactivates old links`, async () => {
        // Given an active bearer.
        const shared = await create();
        // When normal note lifecycle actions run.
        if (action === "archive") await updateNote(noteId, { archived: true });
        else await trashNote(noteId);
        if (action === "purge") await purgeNote(noteId);
        // Then future reads deny, including after restore/unarchive.
        expect(await readShare(tokenOf(shared), now)).toBeNull();
        if (action === "trash") await restoreNote(noteId);
        if (action === "archive") await updateNote(noteId, { archived: false });
        expect(await readShare(tokenOf(shared), now)).toBeNull();
      });
    }
    test("rejects creation on inactive notes and unauthorized revocation", async () => {
      // Given an owner link and a distinct non-owner identity.
      const shared = await create();
      // When a non-owner or inactive note is used.
      await expect(createShare({ noteId, ownerId: randomUUID(), expiresInHours: 24, confirmed: true }, now)).rejects.toMatchObject({ code: "forbidden" });
      await expect(revokeShare({ noteId, ownerId: randomUUID(), shareId: shared.share.id }, now)).rejects.toMatchObject({ code: "not_found" });
      await updateNote(noteId, { archived: true });
      // Then no new capability can be minted.
      await expect(create()).rejects.toMatchObject({ code: "not_found" });
    });
    test("rolls back lifecycle revocation when its note transaction aborts", async () => {
      // Given an active bearer.
      const shared = await create();
      // When an archive transaction is rolled back.
      if (mode === "sqlite") {
        const store = await sqliteStore();
        expect(() => store.transaction((q) => {
          q.run("UPDATE notes SET status='archived' WHERE id=?", [noteId]);
          throw new Error("rollback");
        })).toThrow("rollback");
      } else {
        await expect(tx(async (q) => {
          await q.query("UPDATE notes SET status='archived' WHERE id=$1", [noteId]);
          throw new Error("rollback");
        })).rejects.toThrow("rollback");
      }
      // Then neither note nor share was changed.
      expect(await readShare(tokenOf(shared), now)).not.toBeNull();
    });
    test("rejects malformed capabilities without database interpretation", async () => {
      // Given malformed URLs and a well-shaped unknown bearer.
      for (const token of ["../notes", "a".repeat(63), "A".repeat(64), "a".repeat(64) + "/extra", "b".repeat(64)]) {
        // When read.
        const snapshot = await readShare(token, now);
        // Then no content is returned.
        expect(snapshot).toBeNull();
      }
    });
    test("persists its snapshot across native database reconnect", async () => {
      // Given a committed snapshot.
      const shared = await create();
      // When the database connection is reopened.
      await closeDb(); await closeSQLiteStore();
      // Then persisted text remains readable.
      expect((await readShare(tokenOf(shared), now))?.body).toBe("original");
    });
    test("serializes concurrent creation and trash without leaving readable links", async () => {
      // Given an active note.
      // When creation races a normal trash operation.
      const results = await Promise.allSettled([create(), trashNote(noteId)]);
      // Then trash commits, and any minted capability is denied.
      expect(results[1]?.status).toBe("fulfilled");
      const creation = results[0];
      if (creation?.status === "fulfilled") expect(await readShare(tokenOf(creation.value), now)).toBeNull();
      else expect(creation?.status === "rejected" ? creation.reason : null).toMatchObject({ code: "not_found" });
    });
  });
}

test("requires explicit confirmation and enforces default and maximum lifetimes", () => {
  // Given owner input at the boundary.
  // When parsed.
  expect(shareInput.parse({ confirmed: true }).expiresInHours).toBe(24);
  expect(shareInput.parse({ confirmed: true, expiresInHours: 168 }).expiresInHours).toBe(168);
  // Then invalid and implicit confirmations are rejected.
  for (const input of [{}, { confirmed: false }, { confirmed: true, expiresInHours: 169 }, { confirmed: true, expiresInHours: 0 }, { confirmed: true, expiresInHours: 1.5 }]) {
    expect(shareInput.safeParse(input).success).toBe(false);
  }
});
