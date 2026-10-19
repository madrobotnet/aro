"use client";

import { Inbox, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { CHORD_TIMEOUT_MS, IDLE_CHORD, isEditableTarget, resolveShortcut, type ChordState } from "@/components/shell/shortcuts";
import { Badge, Button, cn, EmptyState, Kbd, Skeleton, SkeletonLines, useToast } from "@/components/ui";
import { api, fetcher } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import { formatDateTime } from "@/lib/i18n/format-date";
import type { InboxItem, Note } from "@/lib/types";
import { INBOX_COPY } from "./inbox-copy";
import {
  applyInboxChange,
  formatCreated,
  INBOX_KEY,
  INBOX_LATER_KEY,
  type InboxChange,
  type InboxListData,
  type InboxView as InboxViewName,
  moveSelection,
  neighbourAfterRemoval,
  replaceItem,
  resolveTriageKey,
  urlStatus,
} from "./inbox-triage";
import { LaterList } from "./LaterList";
import { MergeDialog, type MergeTarget } from "./MergeDialog";
import { SnoozeSheet, type SnoozeTarget } from "./SnoozeSheet";
import { TriageEditor } from "./TriageEditor";
import { refreshNoteViews } from "@/features/notes/note-cache";

function focusRowIfLost(id: string | null) {
  requestAnimationFrame(() => {
    if (!id || (document.activeElement && document.activeElement !== document.body)) return;
    document.querySelector<HTMLElement>(`[data-inbox-item="${id}"]`)?.focus();
  });
}

export function InboxView() {
  const router = useRouter();
  const { toast } = useToast();
  const { locale } = useLocale();
  const copy = useCopy(INBOX_COPY);
  const { mutate: mutateGlobal, cache } = useSWRConfig();
  const { data, error, isLoading, mutate } = useSWR<InboxListData>(INBOX_KEY, fetcher, {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
    refreshInterval: (current) => current?.items.some((item) => urlStatus(item.body) === "pending") ? 2000 : 0,
  });
  const [view, setView] = useState<InboxViewName>("open");
  // `undefined` means choose the first available item; `null` is an explicit cleared selection.
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const [detailOpen, setDetailOpen] = useState(false);
  const [busy, setBusy] = useState<{ id: string; action: "promote" | "suggest" } | null>(null);
  const [snoozeTarget, setSnoozeTarget] = useState<SnoozeTarget | null>(null);
  const [mergeTarget, setMergeTarget] = useState<MergeTarget | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const discarding = useRef(new Set<string>());
  const chord = useRef<ChordState>(IDLE_CHORD);
  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const selected = selectedId === null ? null : (items.find((item) => item.id === selectedId) ?? items[0] ?? null);
  const snoozedCount = data?.snoozedCount ?? 0;

  const refreshAffected = useCallback(() => {
    void refreshNoteViews({ cache, mutate: mutateGlobal });
  }, [cache, mutateGlobal]);

  const applyChange = useCallback(async (change: InboxChange) => {
    await Promise.all([
      mutate((current) => applyInboxChange("open", current, change), { revalidate: false }),
      mutateGlobal<InboxListData>(INBOX_LATER_KEY, (current) => (current ? applyInboxChange("later", current, change) : current), { revalidate: false }),
    ]);
  }, [mutate, mutateGlobal]);

  const promote = useCallback(async (item: InboxItem, draft: { title: string; body: string; tags: string[] }) => {
    setBusy({ id: item.id, action: "promote" });
    try {
      const { note } = await api<{ note: Note }>(`/api/inbox/${item.id}/promote`, { method: "POST", json: draft });
      const next = neighbourAfterRemoval(items, item.id);
      await applyChange({ type: "removed", id: item.id });
      setSelectedId(next);
      refreshAffected();
      toast(textInEveryLocale((locale) => INBOX_COPY[locale].toast.promoted), { tone: "ok" });
      router.push(`/notes/${note.id}`);
    } catch (cause) {
      toast(textInEveryLocale((locale) => localizedApiError(cause, locale, INBOX_COPY[locale].toast.promoteFailed)), { tone: "danger", durationMs: 0 });
    } finally {
      setBusy(null);
    }
  }, [applyChange, items, refreshAffected, router, toast]);

  const restore = useCallback(async (item: InboxItem) => {
    try {
      const { item: restored } = await api<{ item: InboxItem }>(`/api/inbox/${item.id}/restore`, { method: "POST" });
      await applyChange({ type: "restored", item: restored });
      setSelectedId(restored.id);
      refreshAffected();
    } catch (cause) {
      toast(textInEveryLocale((locale) => localizedApiError(cause, locale, INBOX_COPY[locale].toast.undoFailed)), { tone: "danger" });
    }
  }, [applyChange, refreshAffected, toast]);

  // Discard has no confirmation: the item leaves at once and the toast offers Undo.
  const discard = useCallback(async (item: InboxItem) => {
    if (discarding.current.has(item.id)) return;
    discarding.current.add(item.id);
    const next = neighbourAfterRemoval(items, item.id);
    setSelectedId(next);
    setDetailOpen(false);
    await applyChange({ type: "removed", id: item.id });
    focusRowIfLost(next);
    try {
      await api<{ ok: boolean }>(`/api/inbox/${item.id}/discard`, { method: "POST" });
    } catch (cause) {
      await applyChange({ type: "restored", item });
      setSelectedId(item.id);
      toast(textInEveryLocale((locale) => localizedApiError(cause, locale, INBOX_COPY[locale].toast.discardFailed)), { tone: "danger", durationMs: 0 });
      return;
    } finally {
      discarding.current.delete(item.id);
    }
    refreshAffected();
    toast(textInEveryLocale((locale) => INBOX_COPY[locale].toast.discarded), {
      action: { label: textInEveryLocale((locale) => INBOX_COPY[locale].toast.undo), onClick: () => void restore(item) },
    });
  }, [applyChange, items, refreshAffected, restore, toast]);

  const unsnooze = useCallback(async (item: InboxItem, source: "undo" | "later") => {
    try {
      const { item: returned } = await api<{ item: InboxItem }>(`/api/inbox/${item.id}/unsnooze`, { method: "POST" });
      await applyChange({ type: "unsnoozed", item: returned });
      refreshAffected();
      if (source === "undo") setSelectedId(returned.id);
      else toast(textInEveryLocale((locale) => INBOX_COPY[locale].toast.broughtBack), { tone: "ok" });
    } catch (cause) {
      const fallback = source === "undo" ? "undoFailed" : "bringBackFailed";
      toast(textInEveryLocale((locale) => localizedApiError(cause, locale, INBOX_COPY[locale].toast[fallback])), { tone: "danger" });
    }
  }, [applyChange, refreshAffected, toast]);

  const snooze = useCallback(async (item: InboxItem, until: Date) => {
    const { item: snoozed } = await api<{ item: InboxItem }>(`/api/inbox/${item.id}/snooze`, { method: "POST", json: { until: until.toISOString() } });
    const next = neighbourAfterRemoval(items, item.id);
    await applyChange({ type: "snoozed", item: snoozed });
    setSnoozeTarget(null);
    setSelectedId(next);
    setDetailOpen(false);
    focusRowIfLost(next);
    refreshAffected();
    toast(textInEveryLocale((locale) => INBOX_COPY[locale].toast.snoozed(formatDateTime(until, locale))), {
      action: { label: textInEveryLocale((locale) => INBOX_COPY[locale].toast.undo), onClick: () => void unsnooze(snoozed, "undo") },
    });
  }, [applyChange, items, refreshAffected, toast, unsnooze]);

  const merged = useCallback((item: InboxItem, note: Note) => {
    const next = neighbourAfterRemoval(items, item.id);
    void applyChange({ type: "removed", id: item.id });
    void mutateGlobal(`/api/notes/${note.id}`, { note }, { revalidate: false });
    setMergeTarget(null);
    setSelectedId(next);
    setDetailOpen(false);
    focusRowIfLost(next);
    refreshAffected();
    toast(textInEveryLocale((locale) => INBOX_COPY[locale].toast.merged(note.title)), {
      tone: "ok",
      action: { label: textInEveryLocale((locale) => INBOX_COPY[locale].toast.openNote), onClick: () => router.push(`/notes/${note.id}`) },
    });
  }, [applyChange, items, mutateGlobal, refreshAffected, router, toast]);

  const suggest = useCallback(async (item: InboxItem) => {
    setBusy({ id: item.id, action: "suggest" });
    try {
      const { item: updated } = await api<{ item: InboxItem }>(`/api/inbox/${item.id}/suggest`, { method: "POST" });
      await mutate((current) => replaceItem(current, updated), { revalidate: false });
    } catch (cause) {
      toast(textInEveryLocale((locale) => localizedApiError(cause, locale, INBOX_COPY[locale].toast.suggestFailed)), { tone: "danger" });
    } finally {
      setBusy(null);
    }
  }, [mutate, toast]);

  const openSnooze = useCallback((item: InboxItem) => setSnoozeTarget({ item, now: Date.now() }), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const input = {
        key: event.key,
        editable: isEditableTarget(event.target),
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      };
      // Mirror the shell's `g` chord so `g h` goes home instead of snoozing.
      const { pendingGoAt } = chord.current;
      const goChord = pendingGoAt !== null && event.timeStamp - pendingGoAt <= CHORD_TIMEOUT_MS;
      const shell = resolveShortcut(input, chord.current, event.timeStamp);
      chord.current = shell.state;
      if (shell.action || goChord || view !== "open" || busy || document.querySelector("dialog[open]")) return;
      const action = resolveTriageKey(input);
      if (!action) return;
      if (action === "open" && event.target instanceof Element && event.target.closest("button, a, summary")) return;
      event.preventDefault();
      if (action === "next") setSelectedId((current) => moveSelection(items, current ?? null, 1));
      else if (action === "prev") setSelectedId((current) => moveSelection(items, current ?? null, -1));
      else if (action === "first") setSelectedId(items[0]?.id ?? null);
      else if (action === "last") setSelectedId(items.at(-1)?.id ?? null);
      else if (action === "clear") { setSelectedId(null); setDetailOpen(false); }
      else if (action === "open") {
        setDetailOpen(true);
        requestAnimationFrame(() => titleRef.current?.focus());
      }
      else if (!selected) return;
      else if (action === "discard") void discard(selected);
      else if (action === "snooze") openSnooze(selected);
      // Promote and merge go through the editor's buttons, which hold the draft.
      else if (action === "promote") document.querySelector<HTMLButtonElement>(`[data-promote="${selected.id}"]`)?.click();
      else if (action === "merge") document.querySelector<HTMLButtonElement>(`[data-merge="${selected.id}"]`)?.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, discard, items, openSnooze, selected, view]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-12 pt-5 sm:px-6 lg:px-10 lg:pt-10">
      <DocumentTitle title={copy.title} />
      <header className="flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">{copy.title}</h1>
          <p className="mt-1 text-sm text-mute">{copy.intro}</p>
        </div>
        {data ? <Badge className="self-start sm:self-auto" tone={data.count ? "accent" : "neutral"}>{copy.remaining(data.count)}</Badge> : null}
      </header>

      {error && !data ? (
        <div role="alert" className="mt-6 rounded-card border border-danger/30 bg-danger-soft p-5">
          <p className="font-medium text-danger">{copy.loadError.title}</p>
          <p className="mt-1 text-sm text-mute">{localizedApiError(error, locale, copy.loadError.help)}</p>
          <Button className="mt-3" size="lg" leading={<RefreshCw aria-hidden className="size-4" />} onClick={() => void mutate()}>
            {copy.loadError.retry}
          </Button>
        </div>
      ) : null}

      {isLoading && !data ? <InboxSkeleton /> : null}

      {data ? (
        <ViewSwitch
          className={cn("mt-5", detailOpen && view === "open" && "max-lg:hidden")}
          view={view}
          laterCount={snoozedCount}
          onChange={(next) => {
            setView(next);
            setDetailOpen(false);
          }}
        />
      ) : null}

      {data && view === "later" ? <LaterList onBringBack={(item) => unsnooze(item, "later")} /> : null}

      {data && view === "open" && items.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={Inbox}
          title={copy.emptyTitle}
          description={copy.emptyDescription}
        />
      ) : null}

      {view === "open" && items.length ? (
        <div className="mt-4 grid min-w-0 gap-5 lg:grid-cols-[minmax(17rem,0.8fr)_minmax(0,1.6fr)]">
          <div className={`min-w-0 flex-col gap-3 self-start lg:sticky lg:top-6 ${detailOpen ? "hidden lg:flex" : "flex"}`}>
            <ol aria-label={copy.listLabel} className="surface-card max-h-[calc(100dvh-13rem)] divide-y divide-line overflow-y-auto scrollbar-thin">
              {items.map((item) => {
                const active = item.id === selected?.id;
                const status = urlStatus(item.body);
                const preview = item.preview;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-inbox-item={item.id}
                      aria-current={active ? "true" : undefined}
                      disabled={busy !== null}
                      onClick={(event) => {
                        setSelectedId(item.id);
                        setDetailOpen(true);
                        if (event.detail === 0) requestAnimationFrame(() => titleRef.current?.focus());
                      }}
                      className={`min-h-touch w-full px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--focus)] ${active ? "max-lg:hover:bg-desk lg:bg-accent-soft" : "hover:bg-desk"}`}
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                        <span className="shrink-0 text-xs text-mute">{formatCreated(item.createdAt, locale)}</span>
                      </span>
                      {preview || item.url ? <span className="mt-1 line-clamp-2 text-sm leading-relaxed text-mute">{preview || item.url}</span> : null}
                      <span className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Badge>{copy.source[item.source]}</Badge>
                        {status === "pending" ? <Badge tone="warn">{copy.badge.urlPending}</Badge> : null}
                        {status === "failed" ? <Badge tone="danger">{copy.badge.urlFailed}</Badge> : null}
                        {item.suggestions?.status === "ready" ? <Badge tone="ok">{copy.badge.suggestionsReady}</Badge> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <TriageKeyHints />
          </div>
          <div className={`min-w-0 ${detailOpen ? "" : "hidden lg:block"}`}>
            <Button className="mb-3 lg:hidden" variant="ghost" onClick={() => setDetailOpen(false)}>{copy.backToList}</Button>
            {selected ? (
            <TriageEditor
              key={selected.id}
              item={selected}
              titleRef={titleRef}
              busy={busy?.id === selected.id ? busy.action : null}
              onPromote={promote}
              onDiscard={() => void discard(selected)}
              onSnooze={() => openSnooze(selected)}
              onMerge={(edited) => setMergeTarget({ item: selected, edited })}
              onSuggest={suggest}
            />
          ) : (
            <EmptyState variant="plain" title={copy.noSelectionTitle} description={copy.noSelectionDescription} />
            )}
          </div>
        </div>
      ) : null}

      <SnoozeSheet target={snoozeTarget} onOpenChange={(open) => !open && setSnoozeTarget(null)} onSnooze={snooze} />
      <MergeDialog target={mergeTarget} onOpenChange={(open) => !open && setMergeTarget(null)} onMerged={merged} />
    </div>
  );
}

function ViewSwitch({ view, laterCount, onChange, className }: { view: InboxViewName; laterCount: number; onChange: (view: InboxViewName) => void; className?: string }) {
  const copy = useCopy(INBOX_COPY);
  const options: InboxViewName[] = ["open", "later"];
  return (
    <div role="group" aria-label={copy.views.label} className={cn("grid grid-cols-2 gap-1 rounded-card border border-line bg-desk p-1 sm:inline-grid", className)}>
      {options.map((option) => {
        const pressed = option === view;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(option)}
            className={cn(
              "inline-flex min-h-touch items-center justify-center gap-2 rounded-ctl px-4 text-base font-medium transition-[background-color,color,box-shadow] duration-150 focus-ring lg:min-h-9",
              pressed ? "bg-card text-ink shadow-card" : "text-mute hover:text-ink",
            )}
          >
            {copy.views[option]}
            {option === "later" && laterCount > 0 ? <Badge count={laterCount} tone={pressed ? "accent" : "neutral"} /> : null}
          </button>
        );
      })}
    </div>
  );
}

function TriageKeyHints() {
  const copy = useCopy(INBOX_COPY);
  const hints: { keys: string[]; label: string }[] = [
    { keys: ["j", "k"], label: copy.hints.move },
    { keys: ["↵"], label: copy.hints.open },
    { keys: ["1"], label: copy.hints.promote },
    { keys: ["2"], label: copy.hints.discard },
    { keys: ["3"], label: copy.hints.merge },
    { keys: ["H"], label: copy.hints.snooze },
  ];
  return (
    <p className="hidden flex-wrap items-center gap-x-3 gap-y-1.5 px-1 text-xs text-mute lg:flex">
      {hints.map(({ keys, label }) => (
        <span key={label} className="inline-flex items-center gap-1">
          {keys.map((key) => <Kbd key={key}>{key}</Kbd>)} {label}
        </span>
      ))}
    </p>
  );
}

function InboxSkeleton() {
  const copy = useCopy(INBOX_COPY);
  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(17rem,0.8fr)_minmax(0,1.6fr)]" aria-label={copy.loading} aria-busy="true">
      <div className="surface-card flex flex-col gap-5 p-4"><SkeletonLines lines={3} /><SkeletonLines lines={3} /><SkeletonLines lines={3} /></div>
      <div className="surface-card flex flex-col gap-5 p-5"><Skeleton className="h-10 w-full" /><Skeleton className="h-56 w-full" /><SkeletonLines lines={3} /></div>
    </div>
  );
}
