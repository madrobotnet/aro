import { expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { URL_FAILED_MARKER, URL_PENDING_MARKER } from "@/lib/inbox-url-status";
import { setJevForTests } from "@/server/jev/client";
import { createSQLiteNote } from "@/server/notes/sqlite";
import { barrier, inboxFixture } from "./sqlite-test-fixture";
import { captureInbox, discardInbox, enrichInboxItem, getInboxItem, promoteInbox, suggestInbox } from "./service";

const resolve = async () => ["93.184.216.34"];
const textResponse = (text: string) => new Response(text, { headers: { "content-type": "text/plain" } });
const client = (fetch: NonNullable<ConstructorParameters<typeof TypeSafeClient>[0]>["fetch"]) =>
  new TypeSafeClient({ apiKey: "fixture-only", logLevel: "off", retry: { maxRetries: 0 }, fetch });

test("AI-off SQLite settings keep suggestion capture usable without provider calls", async () => {
  const f = await inboxFixture();
  const oldKey = process.env.TYPESAFE_API_KEY;
  try {
    const owner = f.store.get<{ id: string }>("INSERT INTO users(password_hash) VALUES ('fixture') RETURNING id");
    if (!owner) throw new Error("Missing fixture owner");
    f.store.run("INSERT INTO installation_settings(singleton,owner_id,setup_completed,ai) VALUES (1,?,1,?)",
      [owner.id, JSON.stringify({ version: 2, chatId: null, jevId: null })]);
    process.env.TYPESAFE_API_KEY = "ambient-must-not-be-used";
    setJevForTests(undefined);
    const item = await captureInbox({ text: "AI off" });
    expect((await suggestInbox(item.id)).suggestions).toEqual({
      status: "unavailable", tags: [], kind: null, duplicateOf: null,
    });
    expect((await getInboxItem(item.id))?.body).toBe("AI off");
  } finally {
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldKey;
    await f.close();
  }
});

test("suggestions use native note candidates and persist SDK answers", async () => {
  const f = await inboxFixture();
  try {
    const note = f.store.transaction((q) => createSQLiteNote(q, { title: "Candidate" }));
    const trashed = f.store.transaction((q) => createSQLiteNote(q, { title: "Trashed" }));
    f.store.run("UPDATE notes SET deleted_at=updated_at WHERE id=?", [trashed.id]);
    let candidates: unknown;
    setJevForTests(client(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      candidates = request.state.existingNotes;
      return Response.json({ model: "typesafe/jev-1.13", provider: "TypeSafe",
        usage: { input_tokens: 20, output_tokens: 1, cost: 0 },
        answers: {
          kind: { type: "choice", choice: "idea", confidence: 0.8 },
          tag_idea: { type: "noul", noul: 0.9 }, tag_reference: { type: "noul", noul: 0.7 },
          tag_task: { type: "noul", noul: 0.2 },
          duplicate: { type: "choice", choice: note.id, confidence: 0.95, probabilities: { [note.id]: 0.95, none: 0.05 } },
        } });
    }));
    const item = await captureInbox({ text: "candidate text" });
    const suggested = await suggestInbox(item.id);
    expect(candidates).toEqual([{ id: note.id, title: note.title }]);
    expect(suggested.suggestions).toEqual({ status: "ready",
      tags: [{ tag: "idea", probability: 0.9 }, { tag: "reference", probability: 0.7 }],
      kind: { choice: "idea", confidence: 0.8 },
      duplicateOf: { noteId: note.id, title: note.title, probability: 0.95 } });
    expect((await getInboxItem(item.id))?.suggestions).toEqual(suggested.suggestions);
  } finally { await f.close(); }
});

test("provider transport failure persists failed proposals without losing capture", async () => {
  const f = await inboxFixture();
  try {
    setJevForTests(client(async () => { throw new TypeError("fixture failure"); }));
    const item = await captureInbox({ text: "keep capture" });
    expect(await suggestInbox(item.id)).toMatchObject({ body: "keep capture",
      suggestions: { status: "failed", tags: [], kind: null, duplicateOf: null } });
  } finally { await f.close(); }
});

test.each([true, false])("URL intake persists success or failure outside transactions (%s)", async (success) => {
  const f = await inboxFixture();
  try {
    const item = await captureInbox({ text: "original", url: "https://example.com", title: "capture" });
    await enrichInboxItem(item.id, { resolve, fetch: async () => {
      // A separate writer succeeds while URL work is running.
      f.fixture.open().run("UPDATE inbox_items SET title='independent writer' WHERE id=?", [item.id]);
      if (!success) throw new TypeError("fixture URL failure");
      return textResponse("fetched");
    } });
    expect(await getInboxItem(item.id)).toMatchObject({ title: "independent writer",
      body: `original\n\n${success ? "fetched" : URL_FAILED_MARKER}`,
      suggestions: { status: "unavailable" } });
  } finally { await f.close(); }
});

test.each(["promote", "discard"] as const)("late URL intake cannot modify an item after %s", async (action) => {
  const f = await inboxFixture();
  const gate = barrier();
  let enrichment: Promise<void> | undefined;
  try {
    const item = await captureInbox({ text: "original", url: "https://example.com" });
    enrichment = enrichInboxItem(item.id, { resolve, fetch: async () => {
      gate.enter();
      await gate.released;
      return textResponse("too late");
    } });
    await gate.entered;
    if (action === "promote") expect((await promoteInbox(item.id)).body).toBe("original");
    else await discardInbox(item.id);
    gate.release();
    await enrichment;
    expect(await getInboxItem(item.id)).toMatchObject({ body: `original\n\n${URL_PENDING_MARKER}`, suggestions: null });
  } finally {
    gate.release();
    await enrichment;
    await f.close();
  }
}, 5000);

test("late URL intake cannot overwrite an independent body edit", async () => {
  const f = await inboxFixture();
  const gate = barrier();
  let enrichment: Promise<void> | undefined;
  try {
    const item = await captureInbox({ url: "https://example.com" });
    enrichment = enrichInboxItem(item.id, { resolve, fetch: async () => {
      gate.enter();
      await gate.released;
      return textResponse("stale fetched text");
    } });
    await gate.entered;
    f.fixture.open().run("UPDATE inbox_items SET body='newer edit' WHERE id=?", [item.id]);
    gate.release();
    await enrichment;
    expect((await getInboxItem(item.id))?.body).toBe("newer edit");
  } finally {
    gate.release();
    await enrichment;
    await f.close();
  }
}, 5000);

test.each(["promote", "discard", "edit"] as const)("late AI proposals are not persisted after %s", async (action) => {
  const f = await inboxFixture();
  const gate = barrier();
  let suggestion: ReturnType<typeof suggestInbox> | undefined;
  try {
    setJevForTests(client(async () => {
      gate.enter();
      await gate.released;
      return Response.json({ model: "typesafe/jev-1.13", provider: "TypeSafe",
        usage: { input_tokens: 1, output_tokens: 1, cost: 0 },
        answers: { tag_idea: { type: "noul", noul: 0.99 } } });
    }));
    const item = await captureInbox({ text: "before" });
    suggestion = suggestInbox(item.id);
    await gate.entered;
    // All these writes complete while the provider is suspended: no writer is held.
    if (action === "promote") await promoteInbox(item.id);
    else if (action === "discard") await discardInbox(item.id);
    else f.fixture.open().run("UPDATE inbox_items SET body='after' WHERE id=?", [item.id]);
    gate.release();
    expect((await suggestion).suggestions).toBeNull();
    expect((await getInboxItem(item.id))?.suggestions).toBeNull();
  } finally {
    gate.release();
    await suggestion;
    await f.close();
  }
}, 5000);
