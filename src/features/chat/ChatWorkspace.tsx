"use client";

import { ArrowDown, ArrowLeft, CircleAlert, MessageSquare, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { useTimeZone } from "@/components/i18n/useTimeZone";
import { Button, Dialog, EmptyState, Input, Skeleton, SkeletonLines, buttonClassName, cn, useToast } from "@/components/ui";
import { ApiClientError } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import { formatDate } from "@/lib/i18n/format-date";
import type { ChatThread } from "@/lib/types";
import { STATUS_KEY, THREADS_KEY, createThread, deleteThread, getChatStatus, listThreads, renameThread, type ChatStatus } from "./api";
import { ExchangeFailure, Message, PendingExchange } from "./ChatMessages";
import { Composer } from "./Composer";
import { CHAT_COPY } from "./copy";
import { useChatThread } from "./use-chat-thread";

/** Persistent thread navigation and the currently selected cited conversation. */
export function ChatWorkspace({ selectedThreadId }: { selectedThreadId?: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const { locale } = useLocale();
  const copy = useCopy(CHAT_COPY);
  // Null through SSR and hydration, so dates render only once the viewer's own zone is known.
  const timeZone = useTimeZone();
  const threads = useSWR<{ threads: ChatThread[] }>(THREADS_KEY, listThreads, { revalidateOnFocus: true, shouldRetryOnError: false });
  const status = useSWR<ChatStatus>(STATUS_KEY, getChatStatus, { revalidateOnFocus: false, shouldRetryOnError: false });
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { thread } = await createThread();
      await threads.mutate((current) => ({ threads: [thread, ...(current?.threads ?? [])] }), { revalidate: false });
      router.push(`/chat/${thread.id}`);
    } catch (error) {
      toast(textInEveryLocale((locale) => localizedApiError(error, locale, CHAT_COPY[locale].createFailed)), { tone: "danger" });
      setCreating(false);
    }
  };

  // On desktop the landing already shows the setup notice and the new-chat button, so the list hides its copies.
  const ThreadHeading = selectedThreadId ? "h2" : "h1";
  const landingDuplicate = selectedThreadId ? undefined : "lg:hidden";

  return (
    <div className="mx-auto grid h-[var(--workspace-h)] w-full max-w-[100rem] overflow-hidden lg:h-dvh lg:grid-cols-[18rem_minmax(0,1fr)]">
      <DocumentTitle title={copy.title} />
      <aside aria-label={copy.threadsHeading} className={cn("min-w-0 border-line bg-desk lg:flex lg:flex-col lg:border-r", selectedThreadId ? "hidden lg:flex" : "flex flex-col")}>
        <header className="flex items-center gap-3 border-b border-line px-4 py-4">
          <ThreadHeading className="min-w-0 flex-1 text-xl font-semibold tracking-tight">{copy.title}</ThreadHeading>
          <Button variant="primary" size="lg" iconOnly aria-label={copy.newThread} title={copy.newThread} loading={creating} onClick={() => void create()}>
            <Plus aria-hidden className="size-5" />
          </Button>
        </header>
        <StatusNotice status={status.data} loading={status.isLoading} error={status.error} retry={() => void status.mutate()} compact className={landingDuplicate} />
        <nav aria-label={copy.threadsHeading} className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
          {threads.isLoading && !threads.data ? <ThreadListSkeleton /> : null}
          {threads.error && !threads.data ? (
            <EmptyState variant="plain" icon={CircleAlert} title={copy.threadsLoadFailed} action={<Button size="lg" leading={<RefreshCw aria-hidden className="size-4" />} onClick={() => void threads.mutate()}>{copy.retry}</Button>} />
          ) : null}
          {threads.data?.threads.length === 0 ? (
            <EmptyState variant="plain" icon={MessageSquare} title={copy.threadsEmptyTitle} description={copy.threadsEmptyDescription} action={<Button className={landingDuplicate} variant="primary" size="lg" loading={creating} leading={<Plus aria-hidden className="size-4" />} onClick={() => void create()}>{copy.newThread}</Button>} />
          ) : null}
          {threads.data?.threads.length ? (
            <ul className="space-y-1">
              {threads.data.threads.map((thread) => (
                <li key={thread.id}>
                  <Link href={`/chat/${thread.id}`} aria-current={thread.id === selectedThreadId ? "page" : undefined} className={cn("flex min-h-touch flex-col justify-center rounded-ctl px-3 py-2 focus-ring", thread.id === selectedThreadId ? "bg-accent-soft" : "hover:bg-line/50")}>
                    <span className="truncate text-md font-medium">{thread.title}</span>
                    <span className="text-xs text-mute">{timeZone ? formatDate(thread.updatedAt, locale, { timeZone }) : null}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </nav>
      </aside>
      <section aria-label={copy.conversation} className={cn("min-w-0", !selectedThreadId && "hidden lg:block")}>
        {selectedThreadId ? (
          <ThreadView key={selectedThreadId} threadId={selectedThreadId} status={status.data} statusLoading={status.isLoading} statusError={status.error} retryStatus={() => void status.mutate()} />
        ) : (
          <ChatLanding status={status.data} loading={status.isLoading} error={status.error} retry={() => void status.mutate()} create={create} creating={creating} />
        )}
      </section>
    </div>
  );
}

function ChatLanding({ status, loading, error, retry, create, creating }: { status?: ChatStatus; loading: boolean; error: unknown; retry: () => void; create: () => Promise<void>; creating: boolean }) {
  const copy = useCopy(CHAT_COPY);
  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-8 py-12">
      <MessageSquare aria-hidden className="size-9 text-accent" />
      <h2 className="mt-4 text-2xl font-semibold tracking-tight">{copy.title}</h2>
      <p className="mt-2 max-w-xl text-md text-mute">{copy.lead}</p>
      <StatusNotice status={status} loading={loading} error={error} retry={retry} />
      <Button className="mt-5 self-start" variant="primary" size="lg" loading={creating} leading={<Plus aria-hidden className="size-4" />} onClick={() => void create()}>{copy.newThread}</Button>
    </div>
  );
}

function StatusNotice({ status, loading, error, retry, compact = false, className }: { status?: ChatStatus; loading: boolean; error: unknown; retry: () => void; compact?: boolean; className?: string }) {
  const copy = useCopy(CHAT_COPY);
  if (status?.available) return null;
  if (loading && !status) return <p className={cn("text-sm text-mute", compact ? "border-b border-line px-4 py-3" : "mt-5", className)}>{copy.statusChecking}</p>;
  const failed = Boolean(error);
  return (
    <div role={failed ? "alert" : "status"} className={cn("border-warn/30 bg-warn-soft text-ink", compact ? "border-b px-4 py-3" : "mt-5 rounded-card border px-4 py-4", className)}>
      <div className="flex items-start gap-2.5">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{failed ? copy.statusCheckFailed : copy.statusUnavailableTitle}</p>
          {!failed ? <p className="mt-1 text-sm text-mute">{copy.statusUnavailableDescription}</p> : null}
          {failed ? <Button className="mt-2" size="sm" leading={<RefreshCw aria-hidden className="size-3.5" />} onClick={retry}>{copy.statusRecheck}</Button> : null}
        </div>
      </div>
    </div>
  );
}

function ThreadView({ threadId, status, statusLoading, statusError, retryStatus }: { threadId: string; status?: ChatStatus; statusLoading: boolean; statusError: unknown; retryStatus: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const { mutate } = useSWRConfig();
  const chat = useChatThread(threadId);
  const { locale } = useLocale();
  const copy = useCopy(CHAT_COPY);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [detached, setDetached] = useState(false);
  const [renameFailure, setRenameFailure] = useState<{ cause: unknown } | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<{ cause: unknown } | null>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller && following.current) scroller.scrollTop = scroller.scrollHeight;
  }, [chat.messages.length, chat.exchange?.text, chat.exchange?.phase, chat.loading, locale]);
  const jumpToLatest = () => {
    following.current = true;
    setDetached(false);
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  };
  const openRename = () => { setTitle(chat.thread?.title ?? ""); setRenameFailure(null); setRenameOpen(true); };
  const saveTitle = async (event: FormEvent) => {
    event.preventDefault();
    const next = title.trim();
    if (!next || savingTitle) return;
    setSavingTitle(true);
    setRenameFailure(null);
    try {
      const { thread } = await renameThread(threadId, next);
      await mutate(THREADS_KEY, (current: { threads: ChatThread[] } | undefined) => current ? { threads: current.threads.map((item) => item.id === thread.id ? thread : item) } : current, { revalidate: false });
      chat.reload();
      setRenameOpen(false);
    } catch (cause) { setRenameFailure({ cause }); }
    finally { setSavingTitle(false); }
  };
  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteFailure(null);
    try {
      await deleteThread(threadId);
      await mutate(THREADS_KEY, (current: { threads: ChatThread[] } | undefined) => current ? { threads: current.threads.filter((item) => item.id !== threadId) } : current, { revalidate: false });
      toast(textInEveryLocale((locale) => CHAT_COPY[locale].deleted), { tone: "ok" });
      router.replace("/chat");
    } catch (cause) { setDeleteFailure({ cause }); setDeleting(false); }
  };

  if (chat.loading && !chat.thread) return <ThreadSkeleton />;
  if (chat.loadError && !chat.thread) {
    const notFound = chat.loadError instanceof ApiClientError && chat.loadError.status === 404;
    return <div className="flex min-h-[calc(100dvh-var(--topbar-h)-var(--bottomnav-h))] items-center justify-center px-5 lg:min-h-dvh"><EmptyState icon={CircleAlert} title={notFound ? copy.threadNotFound : copy.threadLoadFailed} action={notFound ? <Link href="/chat" className={buttonClassName({ size: "lg" })}>{copy.back}</Link> : <Button size="lg" onClick={chat.reload}>{copy.retry}</Button>} /></div>;
  }

  return (
    <div className="flex h-[var(--workspace-h)] min-h-0 flex-col lg:h-dvh">
      <DocumentTitle title={chat.thread?.title ?? copy.title} />
      <header className="flex min-h-touch items-center gap-2 border-b border-line bg-card px-3 py-2 sm:px-5">
        <Link href="/chat" className={cn(buttonClassName({ variant: "ghost", size: "lg", iconOnly: true }), "lg:hidden")} aria-label={copy.back}><ArrowLeft aria-hidden className="size-5" /></Link>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{chat.thread?.title}</h1>
        <Button variant="ghost" size="lg" iconOnly aria-label={copy.rename} title={copy.rename} disabled={chat.streaming} onClick={openRename}><Pencil aria-hidden className="size-4" /></Button>
        <Button variant="ghost" size="lg" iconOnly aria-label={copy.delete} title={copy.delete} disabled={chat.streaming} onClick={() => { setDeleteFailure(null); setDeleteOpen(true); }}><Trash2 aria-hidden className="size-4" /></Button>
      </header>
      <StatusNotice status={status} loading={statusLoading} error={statusError} retry={retryStatus} />
      <div ref={scrollerRef} data-chat-scroller onScroll={(event) => {
        const scroller = event.currentTarget;
        following.current = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 48;
        setDetached(!following.current);
      }} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 scrollbar-thin [overflow-anchor:none] sm:px-6 lg:px-10">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {chat.messages.length === 0 && !chat.exchange ? <EmptyState icon={MessageSquare} title={copy.historyEmptyTitle} description={copy.historyEmptyDescription} /> : null}
          {chat.messages.map((message) => <Message key={message.id} message={message} />)}
          {chat.exchange ? <PendingExchange exchange={chat.exchange} /> : null}
        </div>
      </div>
      {detached ? <div className="flex justify-center border-t border-line bg-card px-3 py-2"><Button size="lg" leading={<ArrowDown aria-hidden className="size-4" />} onClick={jumpToLatest}>{copy.jumpLatest}</Button></div> : null}
      {chat.exchange?.phase === "failed" ? <div className="border-t border-line bg-card px-3 py-3 sm:px-6 lg:px-10"><div className="mx-auto max-w-3xl"><ExchangeFailure exchange={chat.exchange} onDismiss={chat.dismissFailure} onResend={chat.resend} /></div></div> : null}
      <Composer draft={chat.draft} setDraft={chat.setDraft} send={chat.send} stop={chat.stop} streaming={chat.streaming} available={status?.available === true} />
      <Dialog initialFocusRef={renameInputRef} dismissible={!savingTitle} open={renameOpen} onOpenChange={setRenameOpen} title={copy.rename} footer={<><Button size="lg" disabled={savingTitle} onClick={() => setRenameOpen(false)}>{copy.renameCancel}</Button><Button form="rename-thread" type="submit" variant="primary" size="lg" loading={savingTitle} disabled={!title.trim()}>{copy.renameSave}</Button></>}>
        <form id="rename-thread" onSubmit={(event) => void saveTitle(event)}><Input ref={renameInputRef} label={copy.renameLabel} value={title} maxLength={300} onChange={(event) => setTitle(event.target.value)} /></form>
        {renameFailure ? <p role="alert" className="mt-3 text-sm text-danger">{localizedApiError(renameFailure.cause, locale, copy.renameFailed)}</p> : null}
      </Dialog>
      <Dialog dismissible={!deleting} open={deleteOpen} onOpenChange={setDeleteOpen} title={copy.deleteTitle} description={copy.deleteDescription} footer={<><Button size="lg" disabled={deleting} onClick={() => setDeleteOpen(false)}>{copy.renameCancel}</Button><Button variant="danger" size="lg" loading={deleting} onClick={() => void remove()}>{copy.deleteConfirm}</Button></>}>{deleteFailure ? <p role="alert" className="text-sm text-danger">{localizedApiError(deleteFailure.cause, locale, copy.deleteFailed)}</p> : null}</Dialog>
    </div>
  );
}

function ThreadListSkeleton() {
  const copy = useCopy(CHAT_COPY);
  return <div aria-label={copy.threadsLoading} aria-busy="true" className="space-y-3 px-2 py-3"><SkeletonLines lines={6} /></div>;
}
function ThreadSkeleton() {
  const copy = useCopy(CHAT_COPY);
  return <div aria-label={copy.threadLoading} aria-busy="true" className="flex h-[var(--workspace-h)] flex-col lg:h-dvh"><div className="flex items-center gap-3 border-b border-line px-5 py-4"><Skeleton className="h-5 w-1/3" /></div><div className="mx-auto w-full max-w-3xl flex-1 space-y-8 px-5 py-8"><SkeletonLines lines={3} /><SkeletonLines lines={5} /></div></div>;
}
