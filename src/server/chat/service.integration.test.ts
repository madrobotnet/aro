import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { query, tx } from "@/server/db";
import { ApiError } from "@/server/http";
import { closeDb, connectTestDatabase, resetData } from "@/server/test/db";
import { type CodexSession } from "./auth";
import { ChatProviderError, createCodexProvider, type ChatProvider, type ProviderInput } from "./provider";
import { DEFAULT_THREAD_TITLES } from "@/features/chat/chat-model";
import { chatCopy, EMPTY_ANSWER, NEW_THREAD_TITLE } from "@/server/i18n/copy";
import { readChatStream } from "@/features/chat/sse";
import { sendChatMessage } from "@/features/chat/api";
import {
  createChatMessageStream,
  createChatThread,
  deleteChatThread,
  getChatThread,
  getChatRequestOutcome,
  listChatThreads,
  updateChatThread,
} from "./service";

connectTestDatabase();
beforeEach(resetData);
afterEach(() => mock.restore());
afterAll(async () => {
  await resetData();
  await closeDb();
});

const AUTH: CodexSession = {
  kind: "chatgpt",
  accessToken: "header.payload.signature",
  accountId: "account-test",
  refreshToken: null,
  authFilePath: "/unused/auth.json",
};

function fragmentedResponse(parts: string[]): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[index++];
      if (part === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(part));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function events(body: string): Array<{ event: string; data: unknown }> {
  return body.trim().split("\n\n").map((block) => {
    const lines = block.split("\n");
    return {
      event: lines.find((line) => line.startsWith("event: "))!.slice(7),
      data: JSON.parse(lines.find((line) => line.startsWith("data: "))!.slice(6)) as unknown,
    };
  });
}

async function insertNote(title: string, body: string): Promise<string> {
  const rows = await query<{ id: string }>(
    "INSERT INTO notes (title, body) VALUES ($1, $2) RETURNING id::text",
    [title, body],
  );
  return rows[0]!.id;
}

describe("chat threads", () => {
  test("keeps server and client default titles identical and stores the request-language title", async () => {
    expect(NEW_THREAD_TITLE).toEqual(DEFAULT_THREAD_TITLES);
    expect((await createChatThread(undefined, "en")).title).toBe(DEFAULT_THREAD_TITLES.en);
  });

  test("creates, lists, renames, reads, and deletes a persistent thread", async () => {
    const created = await createChatThread("첫 대화");
    expect(await listChatThreads()).toEqual([created]);

    const renamed = await updateChatThread(created.id, "바뀐 대화");
    expect(renamed.title).toBe("바뀐 대화");
    expect((await getChatThread(created.id)).messages).toEqual([]);

    await deleteChatThread(created.id);
    expect(await listChatThreads()).toEqual([]);
    await expect(getChatThread(created.id)).rejects.toMatchObject({ code: "not_found" });
  });

  test("reads legacy stored citations without rewriting their JSON", async () => {
    const thread = await createChatThread("이전 대화");
    const legacy = [{ noteId: "legacy-note", title: "이전 노트", snippet: "예전 인용문" }];
    await query(
      `INSERT INTO chat_messages (thread_id, role, content, citations)
        VALUES ($1, 'assistant', '이전 답변', $2::jsonb)`,
      [thread.id, JSON.stringify(legacy)],
    );

    expect((await getChatThread(thread.id)).messages[0]!.citations).toEqual([{
      index: 1,
      noteId: "legacy-note",
      title: "이전 노트",
      excerpt: "예전 인용문",
    }]);
    const stored = await query<{ citations: unknown }>(
      "SELECT citations FROM chat_messages WHERE thread_id = $1",
      [thread.id],
    );
    expect(stored[0]!.citations).toEqual(legacy);
  });
});

describe("streamed chat", () => {
  test("uses one identity for valid UUID casing variants", async () => {
    await insertNote("case evidence", "UUID casing question evidence");
    const thread = await createChatThread();
    const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await query("UPDATE chat_threads SET id = $1 WHERE id = $2", [threadId, thread.id]);
    const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let calls = 0;
    const first = await createChatMessageStream(threadId.toUpperCase(), "UUID casing question", {
      requestId: requestId.toUpperCase(),
      provider: { async stream() { calls++; return "case answer"; } },
    });
    await first.text();
    const messages = (await getChatThread(threadId)).messages;
    const assistant = messages[1];
    expect(messages).toHaveLength(2);
    if (!assistant) throw new Error("Missing persisted assistant");
    const replay = await createChatMessageStream(threadId, "UUID casing question", {
      requestId, auth: { kind: "absent" },
    });
    expect(events(await replay.text())).toEqual([{ event: "done", data: { message: assistant } }]);
    expect(await getChatRequestOutcome(threadId.toUpperCase(), requestId.toUpperCase()))
      .toEqual({ message: assistant, content: "UUID casing question" });
    expect((await getChatThread(threadId)).messages).toEqual(messages);
    expect(calls).toBe(1);
  });

  test("replays one persisted exchange when the committed stream loses its terminal event", async () => {
    await insertNote("delivery evidence", "unmatched question delivery evidence");
    const thread = await createChatThread();
    let calls = 0;
    const options = {
      provider: { async stream() { calls++; return "persisted answer"; } },
      requestId: crypto.randomUUID(),
    };
    const first = await createChatMessageStream(thread.id, "unmatched question", options);
    // The transport loses only the terminal frame, after the real server COMMIT.
    const body = (await first.text()).replace(/event: done[\s\S]*$/, "");
    const lost = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
    });
    expect(await readChatStream(lost, {})).toEqual({ kind: "incomplete", reason: "eof" });
    const committed = (await getChatThread(thread.id)).messages;
    expect(committed).toHaveLength(2);
    const assistant = committed[1];
    if (!assistant) throw new Error("Missing persisted assistant");

    const retry = await createChatMessageStream(thread.id, "unmatched question", options);
    expect(events(await retry.text()).at(-1)?.data).toEqual({ message: assistant });
    expect((await getChatThread(thread.id)).messages).toEqual(committed);
    expect(calls).toBe(1);
    expect(await getChatRequestOutcome(thread.id, options.requestId)).toEqual({ message: assistant, content: "unmatched question" });
    const disconnected = await createChatMessageStream(thread.id, "unmatched question", {
      requestId: options.requestId, auth: { kind: "absent" },
    });
    expect(events(await disconnected.text())).toEqual([{ event: "done", data: { message: assistant } }]);
  });

  test("reconciles a lost terminal event with the real persisted request before retrying", async () => {
    await insertNote("reconciliation evidence", "reconciliation question evidence");
    const thread = await createChatThread();
    const requestId = crypto.randomUUID();
    let calls = 0;
    const provider: ChatProvider = { async stream() { calls++; return "persisted answer"; } };
    const requests: string[] = [];
    const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (...[url, init]: Parameters<typeof fetch>) => {
      if (init?.method === "POST") {
        const input = JSON.parse(String(init.body)) as { content: string; requestId: string };
        requests.push(input.requestId);
        const response = await createChatMessageStream(thread.id, input.content, { requestId: input.requestId, provider });
        const body = await response.text();
        return new Response(requests.length === 1 ? body.replace(/event: done[\s\S]*$/, "") : body);
      }
      const id = new URL(String(url), "http://local.test").searchParams.get("requestId");
      if (!id) throw new Error("Missing reconciliation ID");
      return Response.json(await getChatRequestOutcome(thread.id, id));
    }, { preconnect: fetch.preconnect }));

    const input = { threadId: thread.id, requestId, content: "reconciliation question", signal: new AbortController().signal };
    const recovered = await sendChatMessage(input);
    expect(recovered.kind).toBe("done");
    expect(transport.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["POST", "GET"]);
    expect((await getChatThread(thread.id)).messages).toHaveLength(2);
    expect(await sendChatMessage(input)).toEqual(recovered);
    expect(requests).toEqual([requestId, requestId]);
    expect(calls).toBe(1);
    expect((await getChatThread(thread.id)).messages).toHaveLength(2);
  });

  test.each(["failed", "completed"])("rejects changed content and another thread after a %s request", async (state) => {
    const thread = await createChatThread();
    const other = await createChatThread();
    const requestId = crypto.randomUUID();
    const provider: ChatProvider = {
      async stream() {
        if (state === "failed") throw new ChatProviderError();
        return "answer";
      },
    };
    await insertNote("identity question", "identity question evidence");
    await (await createChatMessageStream(thread.id, "identity question", { requestId, provider })).text();
    expect((await getChatThread(thread.id)).messages).toHaveLength(state === "failed" ? 0 : 2);

    await expect(createChatMessageStream(thread.id, "changed question", { requestId, provider }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(createChatMessageStream(other.id, "identity question", { requestId, provider }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(getChatRequestOutcome(other.id, requestId)).rejects.toMatchObject({ code: "not_found" });
  });

  test("allows a failed provider request to retry without persisting partial output", async () => {
    await insertNote("retry evidence", "retry question evidence");
    const thread = await createChatThread();
    const requestId = crypto.randomUUID();
    let calls = 0;
    const provider: ChatProvider = {
      async stream(_input, onDelta) {
        calls++;
        onDelta("partial");
        if (calls === 1) throw new ChatProviderError();
        return "complete";
      },
    };
    await (await createChatMessageStream(thread.id, "retry question", { requestId, provider })).text();
    expect(await getChatRequestOutcome(thread.id, requestId)).toEqual({ message: null, content: "retry question" });
    expect((await getChatThread(thread.id)).messages).toEqual([]);

    await (await createChatMessageStream(thread.id, "retry question", { requestId, provider })).text();
    const saved = (await getChatThread(thread.id)).messages;
    expect(saved.map((message) => message.content)).toEqual(["retry question", "complete"]);
    expect(calls).toBe(2);
  });

  test("does not replay or reconcile archived and deleted thread outcomes", async () => {
    const thread = await createChatThread();
    const options = { requestId: crypto.randomUUID(), provider: { async stream() { throw new Error("no evidence"); } } };
    await (await createChatMessageStream(thread.id, "unmatched", options)).text();
    await query("UPDATE chat_threads SET archived_at = now() WHERE id = $1", [thread.id]);

    await expect(createChatMessageStream(thread.id, "unmatched", options)).rejects.toMatchObject({ code: "not_found" });
    await expect(getChatRequestOutcome(thread.id, options.requestId)).rejects.toMatchObject({ code: "not_found" });
    await deleteChatThread(thread.id);
    await expect(createChatMessageStream(thread.id, "unmatched", options)).rejects.toMatchObject({ code: "not_found" });
    await expect(getChatRequestOutcome(thread.id, options.requestId)).rejects.toMatchObject({ code: "not_found" });
    expect(await query("SELECT id FROM chat_requests WHERE id = $1", [options.requestId])).toEqual([]);
  });

  test("retains the lock after abort until an uncooperative provider settles", async () => {
    await insertNote("abort evidence", "abort question evidence");
    const thread = await createChatThread();
    const requestId = crypto.randomUUID();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let calls = 0;
    const provider: ChatProvider = {
      async stream() {
        calls++;
        entered.resolve();
        await released.promise; // Deliberately ignores the abort signal.
        return "must not persist";
      },
    };
    const abort = new AbortController();
    const response = await createChatMessageStream(thread.id, "abort question", { requestId, provider, signal: abort.signal });
    const finished = response.text();
    await entered.promise;
    abort.abort();
    try {
      expect(await getChatRequestOutcome(thread.id, requestId)).toEqual({ message: null, content: "abort question" });
      await expect(createChatMessageStream(thread.id, "abort question", { requestId, provider }))
        .rejects.toMatchObject({ code: "conflict" });
      await expect(createChatMessageStream(thread.id, "other question", { requestId: crypto.randomUUID(), provider }))
        .rejects.toMatchObject({ code: "conflict" });
      expect(calls).toBe(1);
    } finally {
      released.resolve();
      await finished;
    }
    expect((await getChatThread(thread.id)).messages).toEqual([]);
    await (await createChatMessageStream(thread.id, "abort question", { requestId, provider })).text();
    expect(calls).toBe(2);
    expect((await getChatThread(thread.id)).messages).toHaveLength(2);
  });

  test("rolls back a cancelled response body before the same request can retry", async () => {
    await insertNote("body cancellation", "body cancellation evidence");
    const thread = await createChatThread();
    const requestId = crypto.randomUUID();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const provider: ChatProvider = {
      async stream() { entered.resolve(); await released.promise; return "cancelled answer"; },
    };
    const response = await createChatMessageStream(thread.id, "body cancellation", { requestId, provider });
    await entered.promise;
    if (!response.body) throw new Error("Missing stream body");
    await response.body.cancel();
    // Subscribe to the exact transaction-lock release, not a delay or a poll.
    const waiting = Promise.withResolvers<void>();
    const unlocked = tx(async (client) => {
      await client.query("SET LOCAL lock_timeout = '2s'");
      const acquired = client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [thread.id]);
      waiting.resolve();
      await acquired;
    });
    await waiting.promise;
    released.resolve();
    await unlocked;

    expect((await getChatThread(thread.id)).messages).toEqual([]);
    expect(await getChatRequestOutcome(thread.id, requestId)).toEqual({ message: null, content: "body cancellation" });
    await (await createChatMessageStream(thread.id, "body cancellation", { requestId, provider })).text();
    expect((await getChatThread(thread.id)).messages).toHaveLength(2);
  });

  test("parses fragmented provider frames and persists grounded citations and both messages", async () => {
    const noteId = await insertNote("제주 일정", "성산일출봉은 아침 일찍 방문한다.");
    const thread = await createChatThread();
    const requests: Array<{ url: string; body: string; authorization: string }> = [];
    const provider = createCodexProvider(AUTH, {
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: String(init?.body),
          authorization: new Headers(init?.headers).get("authorization") ?? "",
        });
        return fragmentedResponse([
          "data: {\"type\":\"response.output_",
          "text.delta\",\"delta\":\"아침에 \"}\n\n",
          "data: {\"type\":\"response.output_text.delta\",\"delta\":\"방문하세요.\"}\n",
          "\ndata: {\"type\":\"response.compl",
          "eted\",\"response\":{}}\n\ndata: [DONE]\n\n",
        ]);
      }) as typeof fetch,
      env: { CODEX_MODEL: "gpt-test", CODEX_CHATGPT_BASE_URL: "https://provider.test/codex" },
    });

    const response = await createChatMessageStream(thread.id, "성산일출봉은 언제 가야 해?", { provider, auth: AUTH });
    const streamed = events(await response.text());
    const saved = await getChatThread(thread.id);

    expect(streamed.map((event) => event.event)).toEqual(["citations", "delta", "delta", "done"]);
    expect(streamed[0]!.data).toEqual([{ index: 1, noteId, title: "제주 일정", excerpt: "성산일출봉은 아침 일찍 방문한다." }]);
    expect(saved.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "성산일출봉은 언제 가야 해?"],
      ["assistant", "아침에 방문하세요."],
    ]);
    expect(saved.messages[1]!.citations[0]?.noteId).toBe(noteId);
    expect(requests[0]).toMatchObject({
      url: "https://provider.test/codex/responses",
      authorization: "Bearer header.payload.signature",
    });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: "gpt-test", store: false, stream: true });
    expect(requests[0]!.body).toContain(noteId);
  });

  test("includes recent conversation history in the next provider request", async () => {
    const noteId = await insertNote("회의 기록", "다음 회의는 금요일이다.");
    const thread = await createChatThread();
    const inputs: ProviderInput[] = [];
    const provider: ChatProvider = {
      async stream(input, onDelta) {
        inputs.push(input);
        const answer = inputs.length === 1 ? "금요일입니다." : "앞서 금요일이라고 답했습니다.";
        onDelta(answer);
        return answer;
      },
    };
    await (await createChatMessageStream(thread.id, "다음 회의는 언제야?", { provider, auth: AUTH })).text();
    await (await createChatMessageStream(thread.id, "방금 답을 다시 말해줘", { provider, auth: AUTH })).text();

    expect(inputs[1]!.history).toEqual([
      { role: "user", content: "다음 회의는 언제야?" },
      { role: "assistant", content: "금요일입니다." },
    ]);
    expect(inputs[1]!.sources.map((source) => source.noteId)).toEqual([noteId]);
  });

  test("does not reuse deleted note evidence for a follow-up", async () => {
    const noteId = await insertNote("회의 기록", "다음 회의는 금요일이다.");
    const thread = await createChatThread();
    let calls = 0;
    const provider: ChatProvider = {
      async stream(_input, onDelta) {
        calls++;
        onDelta("금요일입니다.");
        return "금요일입니다.";
      },
    };
    await (await createChatMessageStream(thread.id, "다음 회의는 언제야?", { provider, auth: AUTH })).text();
    await query("UPDATE notes SET deleted_at=now() WHERE id=$1", [noteId]);

    const response = await createChatMessageStream(thread.id, "방금 답을 다시 말해줘", { provider, auth: AUTH });
    const streamed = events(await response.text());
    expect(calls).toBe(1);
    expect(streamed[0]?.data).toEqual([]);
    expect(streamed.at(-1)?.event).toBe("done");
  });

  test("rejects an unavailable chat connection before opening a stream", async () => {
    const thread = await createChatThread();
    const pending = createChatMessageStream(thread.id, "질문", { auth: { kind: "absent" } });
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect((await getChatThread(thread.id)).messages).toEqual([]);
  });

  test("rolls back both messages and emits a safe error when the provider fails", async () => {
    await insertNote("실패 시험", "실패 질문에 관련된 본문");
    const thread = await createChatThread();
    const provider: ChatProvider = { async stream() { throw new ChatProviderError(); } };

    const response = await createChatMessageStream(thread.id, "실패 질문", { provider, auth: AUTH });
    const streamed = events(await response.text());

    expect(streamed.at(-1)).toEqual({
      event: "error",
      data: { code: "upstream_failed", message: chatCopy.upstream.ko },
    });
    expect((await getChatThread(thread.id)).messages).toEqual([]);
    expect(JSON.stringify(streamed)).not.toContain("header.payload.signature");
  });

  test("rolls back when a provider stream ends after deltas without a completion", async () => {
    await insertNote("잘림 시험", "잘림 질문에 관련된 본문");
    const thread = await createChatThread();
    const provider = createCodexProvider(AUTH, {
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        void args;
        return fragmentedResponse([
          'data: {"type":"response.output_text.delta","delta":"저장하면 안 되는 부분 답변"}\n\n',
        ]);
      }) as typeof fetch,
      env: { CODEX_CHATGPT_BASE_URL: "https://provider.test/codex" },
    });

    const response = await createChatMessageStream(thread.id, "잘림 질문", { provider, auth: AUTH });
    const streamed = events(await response.text());

    expect(streamed.map((event) => event.event)).toEqual(["citations", "delta", "error"]);
    expect(streamed.at(-1)).toEqual({
      event: "error",
      data: { code: "upstream_failed", message: chatCopy.upstream.ko },
    });
    expect((await getChatThread(thread.id)).messages).toEqual([]);
  });

  test("rejects a message for a deleted thread before opening a stream", async () => {
    const thread = await createChatThread();
    await deleteChatThread(thread.id);
    await expect(createChatMessageStream(thread.id, "질문", { provider: { async stream() { return "답"; } }, auth: AUTH }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  test("answers honestly without calling the provider when retrieval finds no evidence", async () => {
    const thread = await createChatThread();
    let called = false;
    const provider: ChatProvider = { async stream() { called = true; return "가짜 답"; } };

    const response = await createChatMessageStream(thread.id, "해왕성 탐사선 궤도", { provider, auth: AUTH });
    const streamed = events(await response.text());

    expect(called).toBe(false);
    expect(streamed[0]).toEqual({ event: "citations", data: [] });
    expect((streamed.at(-1)!.data as { message: { content: string } }).message.content)
      .toBe(EMPTY_ANSWER.ko);
  });

  test("uses request locale for empty-source replies and provider input", async () => {
    const emptyThread = await createChatThread(undefined, "en");
    const emptyResponse = await createChatMessageStream(emptyThread.id, "no matching evidence", {
      provider: { async stream() { throw new Error("must not run"); } }, auth: AUTH, locale: "en",
    });
    expect((events(await emptyResponse.text()).at(-1)!.data as { message: { content: string } }).message.content)
      .toBe(EMPTY_ANSWER.en);
    await insertNote("locale evidence", "locale propagation evidence");
    const groundedThread = await createChatThread(undefined, "en");
    let seen: ProviderInput | undefined;
    const provider: ChatProvider = { async stream(input) { seen = input; return "answer"; } };
    await (await createChatMessageStream(groundedThread.id, "locale propagation evidence", { provider, auth: AUTH, locale: "en" })).text();
    expect(seen?.locale).toBe("en");
  });

  test("rejects a concurrent send to the same thread", async () => {
    await insertNote("동시성", "동시성 질문에 대한 근거");
    const thread = await createChatThread();
    let release!: () => void;
    let entered!: () => void;
    const enteredProvider = new Promise<void>((resolve) => { entered = resolve; });
    const providerReleased = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const provider: ChatProvider = {
      async stream(_input, onDelta) {
        calls++;
        entered();
        await providerReleased;
        onDelta("완료");
        return "완료";
      },
    };

    const options = { provider, auth: AUTH, requestId: crypto.randomUUID() };
    const first = await createChatMessageStream(thread.id, "동시성 질문", options);
    const firstBody = first.text();
    await enteredProvider;
    try {
      await expect(createChatMessageStream(thread.id, "동시성 질문", options))
        .rejects.toMatchObject({ code: "conflict" });
      await expect(createChatMessageStream(thread.id, "두 번째 질문", { provider, auth: AUTH }))
        .rejects.toMatchObject({ code: "conflict" });
      expect(calls).toBe(1);
    } finally {
      release();
      await firstBody;
    }
    expect((await getChatThread(thread.id)).messages).toHaveLength(2);
  });
});
