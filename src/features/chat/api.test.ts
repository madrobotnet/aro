import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { sendChatMessage } from "./api";
import type { ChatMessage } from "@/lib/types";

afterEach(() => mock.restore());

const message: ChatMessage = {
  id: "assistant-id", role: "assistant", content: "answer", citations: [], createdAt: "2026-10-11T00:00:00.000Z",
};

test("looks up a committed outcome after EOF without sending another POST", async () => {
  const requestId = crypto.randomUUID();
  const transport = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response('event: delta\ndata: {"text":"partial"}\n\n'))
    .mockResolvedValueOnce(Response.json({ message, content: "question" }));

  const result = await sendChatMessage({ threadId: "qa", content: "question", requestId, signal: new AbortController().signal });

  expect(result).toEqual({ kind: "done", message });
  expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toEqual({ content: "question", requestId });
  expect(transport.mock.calls[1]?.[0]).toBe(`/api/chat/threads/qa/messages?requestId=${requestId}`);
  expect(transport.mock.calls[1]?.[1]?.method).toBeUndefined();
  expect(transport).toHaveBeenCalledTimes(2);
});

test("keeps an unresolved delivery failed when reconciliation itself fails", async () => {
  const transport = spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new TypeError("lost connection"))
    .mockRejectedValueOnce(new TypeError("lookup connection failed"));

  const result = await sendChatMessage({ threadId: "qa", content: "question", requestId: crypto.randomUUID(), signal: new AbortController().signal });

  expect(result).toEqual({ kind: "incomplete", reason: "network" });
  expect(transport).toHaveBeenCalledTimes(2);
});

test("recovers a gateway failure hiding an already committed request", async () => {
  const transport = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ message: "gateway failure" }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ message, content: "question" }));

  const result = await sendChatMessage({ threadId: "qa", content: "question", requestId: crypto.randomUUID(), signal: new AbortController().signal });

  expect(result).toEqual({ kind: "done", message });
  expect(transport).toHaveBeenCalledTimes(2);
});

test("does not mistake another question's persisted outcome for this failed delivery", async () => {
  spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new TypeError("lost connection"))
    .mockResolvedValueOnce(Response.json({ message, content: "other question" }));

  const result = await sendChatMessage({ threadId: "qa", content: "question", requestId: crypto.randomUUID(), signal: new AbortController().signal });

  expect(result).toEqual({ kind: "incomplete", reason: "network" });
});

test("reconciles a cancellation racing commit with a fresh bounded signal", async () => {
  const ctrl = new AbortController();
  const transport = spyOn(globalThis, "fetch")
    .mockImplementationOnce(Object.assign(async () => { ctrl.abort(); throw new DOMException("aborted", "AbortError"); }, { preconnect: fetch.preconnect }))
    .mockResolvedValueOnce(Response.json({ message, content: "question" }));

  const result = await sendChatMessage({ threadId: "qa", content: "question", requestId: crypto.randomUUID(), signal: ctrl.signal });

  expect(result).toEqual({ kind: "done", message });
  const signal = transport.mock.calls[1]?.[1]?.signal;
  expect(signal).not.toBe(ctrl.signal);
  expect(signal?.aborted).toBe(false);
});

test("preserves a content conflict without reconciling it into success", async () => {
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { code: "conflict" } }, { status: 409 }));

  const result = await sendChatMessage({ threadId: "qa", content: "changed", requestId: crypto.randomUUID(), signal: new AbortController().signal });

  expect(result.kind).toBe("error");
  expect(transport).toHaveBeenCalledTimes(1);
});

test("returns a terminal error for a gateway response without the app error shape", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message: "gateway failure" }, { status: 503 }));

  const result = await sendChatMessage({ threadId: "qa", content: "question", requestId: crypto.randomUUID(), signal: new AbortController().signal });

  expect(result).toEqual({ kind: "error", code: "http_error", message: "" });
});

test("keeps the server's localized text so a retained error can follow a language switch", async () => {
  const localized = { ko: "잠시 후 다시 시도해 주세요.", en: "Try again in a moment." };
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ error: { code: "rate_limited", message: "Too many requests", localized } }, { status: 429 }),
  );

  const result = await sendChatMessage({ threadId: "qa", content: "question", requestId: crypto.randomUUID(), signal: new AbortController().signal });

  expect(result).toEqual({ kind: "error", code: "rate_limited", message: "Too many requests", localized });
});
