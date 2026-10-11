import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { openSQLite } from "@/server/db/sqlite";
import { EMPTY_ANSWER } from "@/server/i18n/copy";
import { ChatProviderError, type ChatProvider, type ProviderInput } from "./provider";
import {
  createChatMessageStream, createChatThread, deleteChatThread, getChatRequestOutcome,
  getChatThread, listChatThreads, updateChatThread,
} from "./service";
import { lockThread } from "./sqlite-lock";

const directory = mkdtempSync(join(tmpdir(), "aro-chat-sqlite-"));
const filename = join(directory, "chat.sqlite");
const oldMode = process.env.ARO_DATABASE_MODE;
const oldPath = process.env.ARO_SQLITE_PATH;

beforeEach(async () => {
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = filename;
  const store = await sqliteStore();
  store.run("DELETE FROM chat_threads");
  store.run("DELETE FROM notes");
});
afterAll(async () => {
  await closeSQLiteStore();
  if (oldMode === undefined) delete process.env.ARO_DATABASE_MODE;
  else process.env.ARO_DATABASE_MODE = oldMode;
  if (oldPath === undefined) delete process.env.ARO_SQLITE_PATH;
  else process.env.ARO_SQLITE_PATH = oldPath;
  rmSync(directory, { recursive: true, force: true });
});

async function evidence(): Promise<string> {
  const row = (await sqliteStore()).get<{ id: string }>(
    "INSERT INTO notes(title,body) VALUES ('evidence','grounded question evidence') RETURNING id",
  );
  if (!row) throw new Error("Missing evidence");
  return row.id;
}

function barrierProvider() {
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const provider: ChatProvider = {
    async stream(_input, delta, signal) {
      calls++;
      entered.resolve(signal);
      await release.promise; // Ignores abort deliberately.
      delta("answer");
      return "answer";
    },
  };
  return { entered: entered.promise, release: release.resolve, provider, calls: () => calls };
}

function childLock(threadId: string) {
  const ready = Promise.withResolvers<unknown>();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "sqlite-lock-process.ts"), filename, threadId], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
    ipc: value => ready.resolve(value),
  });
  // A crash before IPC rejects rather than leaving a hanging event barrier.
  void child.exited.then(async code => {
    if (code !== 0) ready.reject(new Error(`Lock child exited ${code}: ${await new Response(child.stderr).text()}`));
  });
  return { child, ready: ready.promise };
}

test("creates, lists, reads, renames and deletes canonical UUID threads", async () => {
  const thread = await createChatThread("  title  ", "en");
  expect(await listChatThreads("en")).toEqual([thread]);
  expect((await getChatThread(thread.id.toUpperCase(), "en")).messages).toEqual([]);
  expect((await updateChatThread(thread.id.toUpperCase(), " changed ", "en")).title).toBe("changed");
  await deleteChatThread(thread.id.toUpperCase());
  expect(await listChatThreads()).toEqual([]);
  await expect(getChatThread(thread.id)).rejects.toMatchObject({ code: "not_found" });
});

test("replays canonical request IDs without provider lookup or duplicate messages", async () => {
  await evidence();
  const thread = await createChatThread();
  const requestId = crypto.randomUUID();
  let calls = 0;
  const provider: ChatProvider = { async stream(_input, delta) { calls++; delta("answer"); return "answer"; } };
  const response = await createChatMessageStream(thread.id.toUpperCase(), "grounded question", { requestId: requestId.toUpperCase(), provider });
  const body = await response.text();
  expect(body).toContain("event: citations");
  expect(body).toContain("event: delta");
  const saved = (await getChatThread(thread.id)).messages;
  const assistant = saved[1];
  if (!assistant) throw new Error("Missing assistant");
  expect(saved.map(row => row.role)).toEqual(["user", "assistant"]);
  const replay = await createChatMessageStream(thread.id, "grounded question", { requestId, auth: { kind: "absent" } });
  expect(await replay.text()).toBe(`event: done\ndata: ${JSON.stringify({ message: saved[1] })}\n\n`);
  expect(await getChatRequestOutcome(thread.id.toUpperCase(), requestId.toUpperCase())).toEqual({
    message: assistant, content: "grounded question",
  });
  expect((await getChatThread(thread.id)).messages).toEqual(saved);
  expect(calls).toBe(1);
});

test.each(["failed", "completed"])("retains immutable reservation after %s provider work", async state => {
  await evidence();
  const thread = await createChatThread();
  const other = await createChatThread();
  const requestId = crypto.randomUUID();
  const provider: ChatProvider = { async stream() { if (state === "failed") throw new ChatProviderError(); return "answer"; } };
  const first = await createChatMessageStream(thread.id, "grounded question", { requestId, provider });
  expect(await first.text()).toContain(state === "failed" ? "upstream_failed" : "event: done");
  expect((await getChatThread(thread.id)).messages).toHaveLength(state === "failed" ? 0 : 2);
  await expect(createChatMessageStream(thread.id, "changed", { requestId, provider })).rejects.toMatchObject({ code: "conflict" });
  await expect(createChatMessageStream(other.id, "grounded question", { requestId, provider })).rejects.toMatchObject({ code: "conflict" });
  await expect(getChatRequestOutcome(other.id, requestId)).rejects.toMatchObject({ code: "not_found" });
  if (state === "failed") {
    expect(await getChatRequestOutcome(thread.id, requestId)).toEqual({ message: null, content: "grounded question" });
    await (await createChatMessageStream(thread.id, "grounded question", {
      requestId, provider: { async stream() { return "retry"; } },
    })).text();
    expect((await getChatThread(thread.id)).messages.map(row => row.content)).toEqual(["grounded question", "retry"]);
  }
});

test("holds native locks after abort until an ignoring provider settles", async () => {
  await evidence();
  const thread = await createChatThread();
  const requestId = crypto.randomUUID();
  const barrier = barrierProvider();
  const abort = new AbortController();
  const response = await createChatMessageStream(thread.id, "grounded question", { requestId, provider: barrier.provider, signal: abort.signal });
  const finished = response.text();
  const signal = await barrier.entered;
  abort.abort();
  try {
    expect(signal.aborted).toBe(true);
    expect(await getChatRequestOutcome(thread.id, requestId)).toEqual({ message: null, content: "grounded question" });
    await expect(createChatMessageStream(thread.id, "grounded question", { requestId, provider: barrier.provider })).rejects.toMatchObject({ code: "conflict" });
    await expect(createChatMessageStream(thread.id, "another", { provider: barrier.provider })).rejects.toMatchObject({ code: "conflict" });
    const contender = childLock(thread.id.toUpperCase());
    try {
      expect(await contender.ready).toEqual({ state: "rejected", code: "conflict" });
      expect(await contender.child.exited).toBe(0);
    } finally {
      contender.child.kill();
      await contender.child.exited;
    }
    expect(barrier.calls()).toBe(1);
  } finally {
    barrier.release();
    await finished;
  }
  expect((await getChatThread(thread.id)).messages).toEqual([]);
  await (await createChatMessageStream(thread.id, "grounded question", { requestId, provider: barrier.provider })).text();
  expect(barrier.calls()).toBe(2);
});

test("body cancellation retains exclusion and prevents late deltas or commits", async () => {
  await evidence();
  const thread = await createChatThread();
  const barrier = barrierProvider();
  const response = await createChatMessageStream(thread.id, "grounded question", { provider: barrier.provider });
  await barrier.entered;
  if (!response.body) throw new Error("Missing response body");
  // Native cross-process blocking acquisition is the exact release subscription.
  const unlocked = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const waiter = Bun.spawn([process.execPath, "-e",
    `import {Database} from "bun:sqlite"; const d=new Database(process.argv[1]); d.run("PRAGMA busy_timeout=2000"); process.send("waiting"); d.run("BEGIN IMMEDIATE"); process.send("unlocked"); d.close(true);`,
    join(`${filename}.chat-locks`, `${thread.id}.sqlite`)], {
    stdout: "pipe", stderr: "pipe",
    ipc: value => { if (value === "unlocked") unlocked.resolve(); if (value === "waiting") waiting.resolve(); },
  });
  try {
    await response.body.cancel();
    expect(() => lockThread(filename, thread.id)).toThrow();
    await waiting.promise;
    barrier.release();
    await unlocked.promise;
    expect(await waiter.exited).toBe(0);
    expect((await getChatThread(thread.id)).messages).toEqual([]);
  } finally {
    barrier.release();
    waiter.kill();
    await waiter.exited;
  }
});

test("allows separate app database writes and another thread during provider work", async () => {
  await evidence();
  const thread = await createChatThread();
  const other = await createChatThread();
  const barrier = barrierProvider();
  const response = await createChatMessageStream(thread.id, "grounded question", { provider: barrier.provider });
  const finished = response.text();
  await barrier.entered;
  try {
    using independent = openSQLite({ filename, busyTimeoutMs: 0 });
    independent.run("INSERT INTO notes(title,body) VALUES ('other write','available')");
    expect(independent.get<{ title: string }>("SELECT title FROM notes WHERE title='other write'")?.title).toBe("other write");
    expect((await updateChatThread(thread.id, "renamed")).title).toBe("renamed");
    await (await createChatMessageStream(other.id, "grounded question", { provider: { async stream() { return "other"; } } })).text();
    expect((await getChatThread(other.id)).messages).toHaveLength(2);
  } finally {
    barrier.release();
    await finished;
  }
  expect((await getChatThread(thread.id)).thread.title).toBe("renamed");
});

test("locks canonical persistent files across connections and process death", async () => {
  const thread = await createChatThread();
  const lockDirectory = `${filename}.chat-locks`;
  const unlock = lockThread(filename, thread.id.toUpperCase());
  const inode = lstatSync(join(lockDirectory, `${thread.id}.sqlite`)).ino;
  expect(() => lockThread(filename, thread.id)).toThrow();
  expect(lstatSync(lockDirectory).mode & 0o077).toBe(0);
  const rejected = childLock(thread.id);
  try {
    expect(await rejected.ready).toEqual({ state: "rejected", code: "conflict" });
    expect(await rejected.child.exited).toBe(0);
  } finally {
    rejected.child.kill();
    await rejected.child.exited;
    unlock();
  }
  const owner = childLock(thread.id);
  try {
    expect(await owner.ready).toEqual({ state: "locked" });
    expect(() => lockThread(filename, thread.id)).toThrow();
  } finally {
    owner.child.kill("SIGKILL");
    await owner.child.exited;
  }
  lockThread(filename, thread.id)();
  expect(lstatSync(join(lockDirectory, `${thread.id}.sqlite`)).ino).toBe(inode);
  await deleteChatThread(thread.id);
  expect(lstatSync(join(lockDirectory, `${thread.id}.sqlite`)).ino).toBe(inode);
});

test("rejects malformed paths and request IDs before creating lock files", async () => {
  const before = readdirSync(`${filename}.chat-locks`);
  expect(() => lockThread(filename, "../escape")).toThrow();
  const thread = await createChatThread();
  await expect(createChatMessageStream(thread.id, "question", { requestId: "../escape" })).rejects.toMatchObject({ code: "validation" });
  expect(readdirSync(`${filename}.chat-locks`)).toEqual(before);
});

test.each(["deleted", "archived"])("rejects late commits and outcomes for %s threads", async state => {
  await evidence();
  const thread = await createChatThread();
  const requestId = crypto.randomUUID();
  const barrier = barrierProvider();
  const response = await createChatMessageStream(thread.id, "grounded question", { requestId, provider: barrier.provider });
  const finished = response.text();
  await barrier.entered;
  try {
    if (state === "deleted") await deleteChatThread(thread.id);
    else (await sqliteStore()).run("UPDATE chat_threads SET archived_at=? WHERE id=?", ["2026-10-11T00:00:00.000000Z", thread.id]);
  } finally { barrier.release(); }
  expect(await finished).toContain("event: error");
  expect((await sqliteStore()).all("SELECT id FROM chat_messages WHERE thread_id=?", [thread.id])).toEqual([]);
  await expect(getChatRequestOutcome(thread.id, requestId)).rejects.toMatchObject({ code: "not_found" });
  await expect(createChatMessageStream(thread.id, "grounded question", { requestId, provider: barrier.provider })).rejects.toMatchObject({ code: "not_found" });
});

test("rolls back both messages and outcome when a final write fails", async () => {
  await evidence();
  const thread = await createChatThread();
  const requestId = crypto.randomUUID();
  const barrier = barrierProvider();
  const response = await createChatMessageStream(thread.id, "grounded question", { requestId, provider: barrier.provider });
  const finished = response.text();
  await barrier.entered;
  // Fault injection on a separate test-only connection, no production schema changes.
  const { Database } = await import("bun:sqlite");
  using raw = new Database(filename);
  raw.run("CREATE TRIGGER fail_chat_outcome BEFORE UPDATE OF assistant_id ON chat_requests BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  try {
    barrier.release();
    expect(await finished).toContain("event: error");
    expect((await getChatThread(thread.id)).messages).toEqual([]);
    expect(await getChatRequestOutcome(thread.id, requestId)).toEqual({ message: null, content: "grounded question" });
  } finally {
    raw.run("DROP TRIGGER fail_chat_outcome");
    barrier.release();
  }
});

test("preserves prior citation fallback, legacy citations, bounded history and localized empty answers", async () => {
  const noteId = await evidence();
  const thread = await createChatThread();
  const seen: ProviderInput[] = [];
  const provider: ChatProvider = { async stream(input) { seen.push(input); return "answer"; } };
  for (let index = 0; index < 7; index++) {
    await (await createChatMessageStream(thread.id, "grounded question", { provider, locale: "en" })).text();
  }
  (await sqliteStore()).run("UPDATE chat_messages SET citations=? WHERE thread_id=? AND role='assistant'",
    [JSON.stringify([{ noteId, title: "legacy", snippet: "old excerpt" }]), thread.id]);
  await (await createChatMessageStream(thread.id, "xyznohit", { provider, locale: "en" })).text();
  expect(seen.at(-1)?.history).toHaveLength(12);
  expect(seen.at(-1)?.sources.map(source => source.noteId)).toEqual([noteId]);
  expect(seen.at(-1)?.locale).toBe("en");
  (await sqliteStore()).run("UPDATE notes SET deleted_at=? WHERE id=?", ["2026-10-11T00:00:00.000000Z", noteId]);
  const response = await createChatMessageStream(thread.id, "xyznohit", { provider, locale: "en" });
  expect(await response.text()).toContain(EMPTY_ANSWER.en);
  expect(seen).toHaveLength(8);
  expect((await getChatThread(thread.id)).messages.map(row => row.role)).toEqual(
    Array.from({ length: 9 }, () => ["user", "assistant"] as const).flat(),
  );
});

test("rejects absent providers and preaborted requests without an exchange", async () => {
  await evidence();
  const thread = await createChatThread();
  await expect(createChatMessageStream(thread.id, "grounded question", { auth: { kind: "absent" } })).rejects.toMatchObject({ code: "unavailable" });
  let calls = 0;
  const response = await createChatMessageStream(thread.id, "grounded question", {
    signal: AbortSignal.abort(), provider: { async stream() { calls++; return "wrong"; } },
  });
  expect(await response.text()).toBe("");
  expect(calls).toBe(0);
  expect((await getChatThread(thread.id)).messages).toEqual([]);
});
