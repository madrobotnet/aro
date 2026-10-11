import { api } from "@/lib/api-client";
import type { ApiErrorBody, ChatMessage, ChatThread } from "@/lib/types";
import { readChatStream, type StreamHandlers, type StreamOutcome } from "./sse";

export const THREADS_KEY = "/api/chat/threads";
export const STATUS_KEY = "/api/chat/status";
export const threadKey = (id: string) => `/api/chat/threads/${id}`;

export type ThreadDetail = { thread: ChatThread; messages: ChatMessage[] };
export type ChatStatus = { available: boolean };

export const listThreads = () => api<{ threads: ChatThread[] }>(THREADS_KEY);
export const createThread = (title?: string) =>
  api<{ thread: ChatThread }>(THREADS_KEY, { method: "POST", json: title ? { title } : {} });
export const getThread = (id: string) => api<ThreadDetail>(threadKey(id));
export const renameThread = (id: string, title: string) =>
  api<{ thread: ChatThread }>(threadKey(id), { method: "PATCH", json: { title } });
export const deleteThread = (id: string) => api<{ ok: boolean }>(threadKey(id), { method: "DELETE" });
export const getChatStatus = () => api<ChatStatus>(STATUS_KEY);

export type SendMessageInput = StreamHandlers & { threadId: string; content: string; requestId: string; signal: AbortSignal };

/**
 * POST a question and consume the SSE answer. Never throws: HTTP failures
 * become `error` outcomes and transport problems become `incomplete`, so the
 * caller always gets one terminal outcome to act on.
 */
async function streamChatMessage({ threadId, content, requestId, signal, onCitations, onDelta }: SendMessageInput): Promise<StreamOutcome> {
  let response: Response;
  try {
    response = await fetch(`${threadKey(threadId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ content, requestId }),
      credentials: "same-origin",
      signal,
    });
  } catch {
    return signal.aborted ? { kind: "aborted" } : { kind: "incomplete", reason: "network" };
  }
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.assign(new URL(`/login?next=${encodeURIComponent(window.location.pathname)}`, window.location.origin));
    return { kind: "error", code: "unauthorized", message: "" };
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    const localized = body?.error?.localized;
    return { kind: "error", code: body?.error?.code ?? "http_error", message: body?.error?.message ?? "", ...(localized ? { localized } : {}) };
  }
  if (!response.body) return { kind: "incomplete", reason: "network" };
  return readChatStream(response.body, { onCitations, onDelta }, signal);
}

/** Recover a committed result before offering a retry; never POST automatically. */
export async function sendChatMessage(input: SendMessageInput): Promise<StreamOutcome> {
  const outcome = await streamChatMessage(input);
  if (outcome.kind === "done") return outcome;
  // Access and input rejections must remain terminal, especially content conflicts.
  // Gateway failures can still hide a committed result, just like a broken SSE.
  if (outcome.kind === "error" && ["unauthorized", "forbidden", "validation", "conflict", "not_found"].includes(outcome.code)) return outcome;
  try {
    // Cancellation can race COMMIT. The aborted POST signal cannot be used here.
    const saved = await api<{ message: ChatMessage | null; content: string | null }>(
      `${threadKey(input.threadId)}/messages?requestId=${encodeURIComponent(input.requestId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (saved.message && saved.content === input.content) return { kind: "done", message: saved.message };
  } catch {
    // Unknown is not failed: retain the ID and let an explicit retry resolve it.
  }
  return outcome;
}
