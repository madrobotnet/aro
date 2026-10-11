"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { Citation } from "@/lib/types";
import { renameThread, sendChatMessage, THREADS_KEY, threadKey, type ThreadDetail } from "./api";
import { isDefaultThreadTitle, type StreamFailure } from "./chat-model";

/** The question currently in flight (or the one that just failed), shown after persisted history. */
export type Exchange = {
  content: string;
  citations: Citation[];
  text: string;
  phase: "streaming" | "failed";
  /** Set when `phase === "failed"`. Kept as data so failureMessage() renders it in the current language. */
  failure: StreamFailure | null;
};

const MAX_AUTO_TITLE = 60;

/**
 * One thread's history plus the streaming state machine. Mount it keyed by
 * thread id: unmounting aborts the in-flight request so a stale answer can
 * never land in another thread.
 */
export function useChatThread(threadId: string) {
  const detail = useSWR<ThreadDetail>(threadKey(threadId), { revalidateOnFocus: false, shouldRetryOnError: false });
  const { mutate: mutateGlobal } = useSWRConfig();
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [draft, setDraft] = useState("");
  const controller = useRef<AbortController | null>(null);
  const pendingRequest = useRef<{ requestId: string; content: string } | null>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

  const send = useCallback(
    async (raw: string): Promise<void> => {
      const content = raw.trim();
      if (!content || controller.current) return;
      const requestId = pendingRequest.current?.content === content
        ? pendingRequest.current.requestId
        : crypto.randomUUID();
      pendingRequest.current = { requestId, content };
      const ctrl = new AbortController();
      controller.current = ctrl;
      const previousMessages = detail.data?.messages.length ?? 0;
      const previousTitle = detail.data?.thread.title ?? null;
      setDraft("");
      setExchange({ content, citations: [], text: "", phase: "streaming", failure: null });

      const outcome = await sendChatMessage({
        threadId,
        content,
        requestId,
        signal: ctrl.signal,
        onCitations: (citations) => setExchange((prev) => (prev ? { ...prev, citations } : prev)),
        onDelta: (text) => setExchange((prev) => (prev ? { ...prev, text: prev.text + text } : prev)),
      });
      if (controller.current !== ctrl) return; // unmounted: state belongs to nobody now
      controller.current = null;

      if (outcome.kind !== "done") {
        const failure: StreamFailure = outcome;
        setExchange((prev) => (prev ? { ...prev, phase: "failed", failure } : prev));
        setDraft((prev) => (prev.trim() ? prev : content));
        return;
      }

      // The server persisted both rows; show them from the `done` payload while the real rows load.
      await detail.mutate(
        (current) =>
          current
            ? {
                ...current,
                messages: [
                  ...current.messages,
                  ...(current.messages.some((message) => message.id === outcome.message.id) ? [] : [
                    { id: `local-${outcome.message.id}`, role: "user" as const, content, citations: [], createdAt: outcome.message.createdAt },
                    outcome.message,
                  ]),
                ],
              }
            : current,
        { revalidate: true },
      ).catch(() => undefined);
      setExchange(null);
      pendingRequest.current = null;

      if (previousMessages === 0 && isDefaultThreadTitle(previousTitle)) {
        const title = content.replace(/\s+/g, " ").slice(0, MAX_AUTO_TITLE);
        await renameThread(threadId, title)
          .then(({ thread }) => detail.mutate((current) => (current ? { ...current, thread } : current), { revalidate: false }))
          .catch(() => undefined);
      }
      void mutateGlobal(THREADS_KEY);
    },
    [detail, mutateGlobal, threadId],
  );

  const stop = useCallback(() => controller.current?.abort(), []);
  const dismissFailure = useCallback(() => setExchange((prev) => (prev?.phase === "failed" ? null : prev)), []);
  const resend = useCallback(() => {
    if (exchange?.phase === "failed") void send(exchange.content);
  }, [exchange, send]);

  return {
    thread: detail.data?.thread ?? null,
    messages: detail.data?.messages ?? [],
    loading: detail.isLoading,
    loadError: detail.error as unknown,
    reload: () => void detail.mutate(),
    exchange,
    streaming: exchange?.phase === "streaming",
    draft,
    setDraft,
    send,
    stop,
    resend,
    dismissFailure,
  };
}
