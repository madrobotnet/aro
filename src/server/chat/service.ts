import type { PoolClient } from "pg";
import type { ChatMessage, ChatThread, Citation } from "@/lib/types";
import type { Locale } from "@/lib/i18n/locale";
import { excerpt } from "@/lib/wikilinks";
import { db, query, queryOne } from "@/server/db";
import { databaseBackend } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { chatCopy, EMPTY_ANSWER, NEW_THREAD_TITLE } from "@/server/i18n/copy";
import { searchNotes } from "@/server/search/service";
import type { CodexAuth } from "./auth";
import { configuredChatProvider } from "./connection";
import { ChatProviderError, createCodexProvider, type ChatProvider, type ProviderMessage } from "./provider";

export type ThreadRow = { id: string; title: string | null; created_at: Date | string; updated_at: Date | string };
export type MessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: unknown;
  created_at: Date | string;
};
export type StreamOptions = { auth?: CodexAuth; provider?: ChatProvider; signal?: AbortSignal; locale?: Locale; requestId?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function mapThread(row: ThreadRow, locale: Locale): ChatThread {
  return { id: row.id, title: row.title || NEW_THREAD_TITLE[locale], createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

export function citations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, position): Citation[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.noteId !== "string" || typeof row.title !== "string") return [];
    if (typeof row.index === "number" && typeof row.excerpt === "string") {
      return [{ index: row.index, noteId: row.noteId, title: row.title, excerpt: row.excerpt }];
    }
    return [{
      index: position + 1,
      noteId: row.noteId,
      title: row.title,
      excerpt: typeof row.snippet === "string" ? row.snippet : "",
    }];
  });
}

export function mapMessage(row: MessageRow): ChatMessage {
  return { id: row.id, role: row.role, content: row.content, citations: citations(row.citations), createdAt: iso(row.created_at) };
}

export function validId(id: string): void {
  if (!UUID.test(id)) throw new ApiError("not_found", chatCopy.threadNotFound);
}

export async function getChatStatus(): Promise<{ available: boolean }> {
  return { available: (await configuredChatProvider()) !== null };
}

export async function listChatThreads(locale: Locale = "ko"): Promise<ChatThread[]> {
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).listThreads(locale);
  return (await query<ThreadRow>(
    "SELECT id::text, title, created_at, updated_at FROM chat_threads WHERE archived_at IS NULL ORDER BY updated_at DESC, id DESC",
  )).map((row) => mapThread(row, locale));
}

export async function createChatThread(title?: string, locale: Locale = "ko"): Promise<ChatThread> {
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).createThread(title, locale);
  const row = await queryOne<ThreadRow>(
    "INSERT INTO chat_threads (title) VALUES ($1) RETURNING id::text, title, created_at, updated_at",
    [title?.trim() || NEW_THREAD_TITLE[locale]],
  );
  return mapThread(row!, locale);
}

export async function getChatThread(id: string, locale: Locale = "ko"): Promise<{ thread: ChatThread; messages: ChatMessage[] }> {
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).getThread(id, locale);
  validId(id);
  const row = await queryOne<ThreadRow>(
    "SELECT id::text, title, created_at, updated_at FROM chat_threads WHERE id = $1 AND archived_at IS NULL",
    [id],
  );
  if (!row) throw new ApiError("not_found", chatCopy.threadNotFound);
  const messages = await query<MessageRow>(
    `SELECT id::text, role, content, citations, created_at FROM chat_messages
      WHERE thread_id = $1 AND role IN ('user', 'assistant') ORDER BY created_at, id`,
    [id],
  );
  return { thread: mapThread(row, locale), messages: messages.map(mapMessage) };
}

export async function updateChatThread(id: string, title: string, locale: Locale = "ko"): Promise<ChatThread> {
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).updateThread(id, title, locale);
  validId(id);
  const row = await queryOne<ThreadRow>(
    `UPDATE chat_threads SET title = $2, updated_at = now()
      WHERE id = $1 AND archived_at IS NULL RETURNING id::text, title, created_at, updated_at`,
    [id, title.trim()],
  );
  if (!row) throw new ApiError("not_found", chatCopy.threadNotFound);
  return mapThread(row, locale);
}

export async function deleteChatThread(id: string): Promise<void> {
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).deleteThread(id);
  validId(id);
  const row = await queryOne<{ id: string }>("DELETE FROM chat_threads WHERE id = $1 RETURNING id::text", [id]);
  if (!row) throw new ApiError("not_found", chatCopy.threadNotFound);
}

/** A null outcome is not proof of failure: the request may still be generating. */
export async function getChatRequestOutcome(threadId: string, requestId: string): Promise<{ message: ChatMessage | null; content: string | null }> {
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).requestOutcome(threadId, requestId);
  validId(threadId);
  threadId = threadId.toLowerCase();
  validId(requestId);
  const thread = await queryOne<{ id: string }>(
    "SELECT id::text FROM chat_threads WHERE id = $1 AND archived_at IS NULL", [threadId],
  );
  if (!thread) throw new ApiError("not_found", chatCopy.threadNotFound);
  const request = await queryOne<{ thread_id: string; content: string }>("SELECT thread_id::text, content FROM chat_requests WHERE id = $1", [requestId]);
  if (request && request.thread_id !== threadId) throw new ApiError("not_found", chatCopy.threadNotFound);
  const message = await queryOne<MessageRow>(
    `SELECT m.id::text, m.role, m.content, m.citations, m.created_at
      FROM chat_requests r JOIN chat_messages m ON m.id = r.assistant_id AND m.thread_id = r.thread_id
      JOIN chat_threads t ON t.id = r.thread_id AND t.archived_at IS NULL
      WHERE r.id = $1 AND r.thread_id = $2`, [requestId, threadId],
  );
  return { message: message ? mapMessage(message) : null, content: request?.content ?? null };
}

export function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
  client.release();
}

export async function createChatMessageStream(
  threadId: string,
  content: string,
  options: StreamOptions = {},
): Promise<Response> {
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).messageStream(threadId, content, options);
  const locale = options.locale ?? "ko";
  validId(threadId);
  threadId = threadId.toLowerCase();
  const requestId = options.requestId ?? crypto.randomUUID();
  if (!UUID.test(requestId)) throw new ApiError("validation", chatCopy.failed);
  // Reserve immutable identity separately: provider failure/cancellation rolls back
  // the exchange, not the binding between this ID, thread, and question.
  await query(
    `INSERT INTO chat_requests (id, thread_id, content)
      SELECT $1, id, $3 FROM chat_threads WHERE id = $2 AND archived_at IS NULL
      ON CONFLICT (id) DO NOTHING`, [requestId, threadId, content],
  );

  const pool = await db();
  const client = await pool.connect();
  await client.query("BEGIN");
  let provider = options.provider;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked",
      [threadId],
    );
    if (!lock.rows[0]?.locked) throw new ApiError("conflict", chatCopy.busy);
    const thread = await client.query<{ id: string }>(
      // Keep archive/delete serialized, but allow another request's FK identity
      // reservation to finish so it can observe the advisory lock and return busy.
      "SELECT id::text FROM chat_threads WHERE id = $1 AND archived_at IS NULL FOR NO KEY UPDATE",
      [threadId],
    );
    if (!thread.rows[0]) throw new ApiError("not_found", chatCopy.threadNotFound);
    const request = await client.query<{ thread_id: string; content: string; assistant_id: string | null }>(
      "SELECT thread_id::text, content, assistant_id::text FROM chat_requests WHERE id = $1", [requestId],
    );
    const saved = request.rows[0];
    if (!saved || saved.thread_id !== threadId || saved.content !== content) throw new ApiError("conflict", chatCopy.failed);
    if (saved.assistant_id) {
      const message = await client.query<MessageRow>(
        "SELECT id::text, role, content, citations, created_at FROM chat_messages WHERE id = $1 AND thread_id = $2",
        [saved.assistant_id, threadId],
      );
      await client.query("COMMIT");
      client.release();
      return new Response(new TextDecoder().decode(sse("done", { message: mapMessage(message.rows[0]!) })), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
      });
    }
    if (!provider) {
      if (options.auth) {
        switch (options.auth.kind) {
          case "chatgpt":
            provider = createCodexProvider(options.auth);
            break;
          case "absent":
          case "blocked":
            break;
          default: {
            const exhaustive: never = options.auth;
            throw exhaustive;
          }
        }
      } else {
        provider = await configuredChatProvider() ?? undefined;
      }
    }
    if (!provider) throw new ApiError("unavailable", chatCopy.noProvider);
  } catch (error) {
    await rollback(client);
    throw error;
  }

  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  if (options.signal?.aborted) abort.abort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  let settled = false;
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          const historyResult = await client.query<MessageRow>(
            `SELECT id::text, role, content, citations, created_at FROM chat_messages
              WHERE thread_id = $1 AND role IN ('user', 'assistant')
              ORDER BY created_at DESC, id DESC LIMIT 12`,
            [threadId],
          );
          const search = await searchNotes(content, { limit: 8 });
          abort.signal.throwIfAborted();
          const sourceCitations: Citation[] = search.hits.map((hit, index) => ({
            index: index + 1,
            noteId: hit.noteId,
            title: hit.title,
            excerpt: hit.snippet,
          }));
          if (sourceCitations.length === 0) {
            const priorIds = [...new Set(historyResult.rows.flatMap((message) =>
              citations(message.citations).map((citation) => citation.noteId).filter((id) => UUID.test(id)),
            ))].slice(0, 8);
            if (priorIds.length) {
              const prior = await client.query<{ id: string; title: string; body: string }>(
                `SELECT id::text, title, body FROM notes
                  WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND status <> 'archived'
                  ORDER BY array_position($1::uuid[], id)`,
                [priorIds],
              );
              sourceCitations.push(...prior.rows.map((note, index) => ({
                index: index + 1, noteId: note.id, title: note.title, excerpt: excerpt(note.body, 220),
              })));
            }
          }
          controller.enqueue(sse("citations", sourceCitations));

          let answer = EMPTY_ANSWER[locale];
          if (sourceCitations.length > 0) {
            const history: ProviderMessage[] = historyResult.rows.reverse().map((message) => ({
              role: message.role,
              content: message.content,
            }));
            answer = await provider.stream({ question: content, history, sources: sourceCitations, locale },
              (text) => controller.enqueue(sse("delta", { text })), abort.signal);
          } else {
            controller.enqueue(sse("delta", { text: answer }));
          }

          abort.signal.throwIfAborted();
          const user = await client.query<{ created_at: Date }>(
            `INSERT INTO chat_messages (thread_id, role, content, citations)
              VALUES ($1, 'user', $2, '[]'::jsonb) RETURNING created_at`,
            [threadId, content],
          );
          const inserted = await client.query<MessageRow>(
            `INSERT INTO chat_messages (thread_id, role, content, citations, created_at)
              VALUES ($1, 'assistant', $2, $3::jsonb, greatest(clock_timestamp(), $4::timestamptz + interval '1 microsecond'))
              RETURNING id::text, role, content, citations, created_at`,
            [threadId, answer, JSON.stringify(sourceCitations), user.rows[0]!.created_at],
          );
          await client.query("UPDATE chat_threads SET updated_at = now() WHERE id = $1", [threadId]);
          await client.query("UPDATE chat_requests SET assistant_id = $2 WHERE id = $1", [requestId, inserted.rows[0]!.id]);
          await client.query("COMMIT");
          settled = true;
          controller.enqueue(sse("done", { message: mapMessage(inserted.rows[0]!) }));
          controller.close();
        } catch (error) {
          if (!settled) await client.query("ROLLBACK").catch(() => undefined);
          settled = true;
          if (!abort.signal.aborted) {
            const code = error instanceof ChatProviderError ? "upstream_failed" : "internal";
            const message = error instanceof ChatProviderError
              ? chatCopy.upstream[locale]
              : chatCopy.failed[locale];
            controller.enqueue(sse("error", { code, message }));
            controller.close();
          } else if (!cancelled) controller.close();
        } finally {
          options.signal?.removeEventListener("abort", onAbort);
          client.release();
        }
      })();
    },
    cancel() {
      cancelled = true;
      abort.abort();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
