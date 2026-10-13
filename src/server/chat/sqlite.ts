import type { ChatMessage, ChatThread, Citation } from "@/lib/types";
import type { Locale } from "@/lib/i18n/locale";
import { excerpt } from "@/lib/wikilinks";
import { sqliteStore } from "@/server/db/backend";
import type { SQLiteExecutor } from "@/server/db/sqlite";
import { ApiError } from "@/server/http";
import { chatCopy, EMPTY_ANSWER, NEW_THREAD_TITLE } from "@/server/i18n/copy";
import { searchNotes } from "@/server/search/service";
import { configuredChatProvider } from "./connection";
import { ChatProviderError, createCodexProvider } from "./provider";
import { mapMessage, mapThread, sse, validId, type MessageRow, type StreamOptions, type ThreadRow } from "./service";
import { lockThread } from "./sqlite-lock";

type StoredMessage = Omit<MessageRow, "citations"> & { readonly citations: string };
type RequestRow = { readonly thread_id: string; readonly content: string; readonly assistant_id: string | null };

function message(row: StoredMessage): ChatMessage {
  return mapMessage({ ...row, citations: JSON.parse(row.citations) });
}

function activeThread(store: SQLiteExecutor, id: string): ThreadRow {
  const row = store.get<ThreadRow>(
    "SELECT id,title,created_at,updated_at FROM chat_threads WHERE id=? AND archived_at IS NULL", [id],
  );
  if (!row) throw new ApiError("not_found", chatCopy.threadNotFound);
  return row;
}

export async function listThreads(locale: Locale): Promise<ChatThread[]> {
  return (await sqliteStore()).all<ThreadRow>(
    "SELECT id,title,created_at,updated_at FROM chat_threads WHERE archived_at IS NULL ORDER BY updated_at DESC,id DESC",
  ).map(row => mapThread(row, locale));
}

export async function createThread(title: string | undefined, locale: Locale): Promise<ChatThread> {
  const row = (await sqliteStore()).get<ThreadRow>(
    "INSERT INTO chat_threads(title) VALUES (?) RETURNING id,title,created_at,updated_at",
    [title?.trim() || NEW_THREAD_TITLE[locale]],
  );
  if (!row) throw new Error("Chat thread insert returned no row");
  return mapThread(row, locale);
}

export async function getThread(id: string, locale: Locale): Promise<{ thread: ChatThread; messages: ChatMessage[] }> {
  validId(id);
  id = id.toLowerCase();
  const store = await sqliteStore();
  const thread = activeThread(store, id);
  return {
    thread: mapThread(thread, locale),
    messages: store.all<StoredMessage>(
      "SELECT id,role,content,citations,created_at FROM chat_messages WHERE thread_id=? AND role IN ('user','assistant') ORDER BY created_at,id", [id],
    ).map(message),
  };
}

// CRUD uses short main-DB writes rather than waiting on the provider lock.
// The final transaction revalidates both thread and immutable reservation;
// deletion/archive during generation therefore cannot produce a late commit.
export async function updateThread(id: string, title: string, locale: Locale): Promise<ChatThread> {
  validId(id);
  const row = (await sqliteStore()).get<ThreadRow>(
    "UPDATE chat_threads SET title=?,updated_at=? WHERE id=? AND archived_at IS NULL RETURNING id,title,created_at,updated_at",
    [title.trim(), timestamp(), id.toLowerCase()],
  );
  if (!row) throw new ApiError("not_found", chatCopy.threadNotFound);
  return mapThread(row, locale);
}

export async function deleteThread(id: string): Promise<void> {
  validId(id);
  const row = (await sqliteStore()).get<{ id: string }>("DELETE FROM chat_threads WHERE id=? RETURNING id", [id.toLowerCase()]);
  if (!row) throw new ApiError("not_found", chatCopy.threadNotFound);
}

export async function requestOutcome(threadId: string, requestId: string): Promise<{ message: ChatMessage | null; content: string | null }> {
  validId(threadId);
  validId(requestId);
  threadId = threadId.toLowerCase();
  requestId = requestId.toLowerCase();
  const store = await sqliteStore();
  activeThread(store, threadId);
  const request = store.get<RequestRow>("SELECT thread_id,content,assistant_id FROM chat_requests WHERE id=?", [requestId]);
  if (request && request.thread_id !== threadId) throw new ApiError("not_found", chatCopy.threadNotFound);
  const row = store.get<StoredMessage>(
    `SELECT m.id,m.role,m.content,m.citations,m.created_at FROM chat_requests r
      JOIN chat_messages m ON m.id=r.assistant_id AND m.thread_id=r.thread_id
      JOIN chat_threads t ON t.id=r.thread_id AND t.archived_at IS NULL WHERE r.id=? AND r.thread_id=?`,
    [requestId, threadId],
  );
  return { message: row ? message(row) : null, content: request?.content ?? null };
}

function timestamp(time = Date.now()): string {
  return new Date(time).toISOString().replace(/Z$/, "000Z");
}

export async function messageStream(threadId: string, content: string, options: StreamOptions): Promise<Response> {
  const locale = options.locale ?? "ko";
  validId(threadId);
  threadId = threadId.toLowerCase();
  const requestId = (options.requestId ?? crypto.randomUUID()).toLowerCase();
  try {
    validId(requestId);
  } catch {
    throw new ApiError("validation", chatCopy.failed);
  }
  const store = await sqliteStore();
  // This binding survives provider failure and cancellation.
  store.transaction(tx => {
    activeThread(tx, threadId);
    tx.run("INSERT INTO chat_requests(id,thread_id,content) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
      [requestId, threadId, content]);
  });
  const filename = process.env.ARO_SQLITE_PATH;
  if (!filename) throw new Error("Missing SQLite filename");
  const unlock = await lockThread(filename, threadId);
  let provider = options.provider;
  const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" };
  let history: StoredMessage[];
  try {
    activeThread(store, threadId);
    const saved = store.get<RequestRow>("SELECT thread_id,content,assistant_id FROM chat_requests WHERE id=?", [requestId]);
    if (!saved || saved.thread_id !== threadId || saved.content !== content) throw new ApiError("conflict", chatCopy.failed);
    if (saved.assistant_id) {
      const row = store.get<StoredMessage>("SELECT id,role,content,citations,created_at FROM chat_messages WHERE id=? AND thread_id=?",
        [saved.assistant_id, threadId]);
      if (!row) throw new Error("Missing reserved assistant message");
      unlock();
      return new Response(new TextDecoder().decode(sse("done", { message: message(row) })), { headers });
    }
    if (!provider) {
      if (options.auth) {
        switch (options.auth.kind) {
          case "chatgpt": provider = createCodexProvider(options.auth); break;
          case "absent":
          case "blocked": break;
          default: { const exhaustive: never = options.auth; throw exhaustive; }
        }
      } else provider = await configuredChatProvider() ?? undefined;
    }
    if (!provider) throw new ApiError("unavailable", chatCopy.noProvider);
    history = store.all<StoredMessage>(
      "SELECT id,role,content,citations,created_at FROM chat_messages WHERE thread_id=? AND role IN ('user','assistant') ORDER BY created_at DESC,id DESC LIMIT 12",
      [threadId],
    );
  } catch (error) {
    unlock();
    throw error;
  }

  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  if (options.signal?.aborted) abort.abort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown): void => {
        if (!abort.signal.aborted) controller.enqueue(sse(event, data));
      };
      void (async () => {
        try {
          const search = await searchNotes(content, { limit: 8 });
          abort.signal.throwIfAborted();
          const sources: Citation[] = search.hits.map((hit, index) => ({
            index: index + 1, noteId: hit.noteId, title: hit.title, excerpt: hit.snippet,
          }));
          if (!sources.length) {
            const ids = [...new Set(history.flatMap(row => message(row).citations.map(citation => citation.noteId)))]
              .filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)).slice(0, 8);
            for (const id of ids) {
              const note = store.get<{ id: string; title: string; body: string }>(
                "SELECT id,title,body FROM notes WHERE id=? AND deleted_at IS NULL AND status<>'archived'", [id.toLowerCase()],
              );
              if (note) sources.push({ index: sources.length + 1, noteId: note.id, title: note.title, excerpt: excerpt(note.body, 220) });
            }
          }
          emit("citations", sources);
          let answer = EMPTY_ANSWER[locale];
          if (sources.length) {
            answer = await provider.stream({
              question: content, history: history.reverse().map(row => ({ role: row.role, content: row.content })), sources, locale,
            }, text => emit("delta", { text }), abort.signal);
          } else emit("delta", { text: answer });
          abort.signal.throwIfAborted();
          const assistant = store.transaction(tx => {
            activeThread(tx, threadId);
            const saved = tx.get<RequestRow>("SELECT thread_id,content,assistant_id FROM chat_requests WHERE id=?", [requestId]);
            if (!saved || saved.thread_id !== threadId || saved.content !== content || saved.assistant_id) {
              throw new ApiError("conflict", chatCopy.failed);
            }
            const latest = tx.get<{ created_at: string }>(
              "SELECT created_at FROM chat_messages WHERE thread_id=? ORDER BY created_at DESC,id DESC LIMIT 1", [threadId],
            );
            const now = Math.max(Date.now(), latest ? new Date(latest.created_at).getTime() + 1 : 0);
            tx.run("INSERT INTO chat_messages(thread_id,role,content,citations,created_at) VALUES (?,'user',?,'[]',?)",
              [threadId, content, timestamp(now)]);
            const row = tx.get<StoredMessage>(
              "INSERT INTO chat_messages(thread_id,role,content,citations,created_at) VALUES (?,'assistant',?,?,?) RETURNING id,role,content,citations,created_at",
              [threadId, answer, JSON.stringify(sources), timestamp(now + 1)],
            );
            if (!row) throw new Error("Chat message insert returned no row");
            tx.run("UPDATE chat_threads SET updated_at=? WHERE id=?", [timestamp(now + 1), threadId]);
            tx.run("UPDATE chat_requests SET assistant_id=? WHERE id=?", [row.id, requestId]);
            return message(row);
          });
          emit("done", { message: assistant });
          controller.close();
        } catch (error) {
          if (!abort.signal.aborted) {
            emit("error", {
              code: error instanceof ChatProviderError ? "upstream_failed" : "internal",
              message: error instanceof ChatProviderError ? chatCopy.upstream[locale] : chatCopy.failed[locale],
            });
            controller.close();
          } else if (!cancelled) controller.close();
        } finally {
          options.signal?.removeEventListener("abort", onAbort);
          // Only the settled provider can release this lock, never cancel().
          unlock();
        }
      })();
    },
    cancel() {
      cancelled = true;
      abort.abort();
    },
  });
  return new Response(body, { headers });
}
