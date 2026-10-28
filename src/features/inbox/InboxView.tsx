"use client";

import { Inbox } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useCopy } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { Button, cn, EmptyState, useToast } from "@/components/ui";
import { api, fetcher } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import { formatDateTime } from "@/lib/i18n/format-date";
import type { InboxItem, Note } from "@/lib/types";
import { INBOX_COPY } from "./inbox-copy";
import {
  applyInboxChange,
  INBOX_KEY,
  INBOX_LATER_KEY,
  type InboxChange,
  type InboxListData,
  type InboxView as InboxViewName,
  neighbourAfterRemoval,
  replaceItem,
  urlStatus,
} from "./inbox-triage";
import { LaterList } from "./LaterList";
import { MergeDialog, type MergeTarget } from "./MergeDialog";
import { SnoozeSheet, type SnoozeTarget } from "./SnoozeSheet";
import { TriageEditor } from "./TriageEditor";
import { InboxHeading, InboxList, InboxSkeleton, InboxViewSwitch } from "./InboxList";
import { useInboxCommands } from "./useInboxCommands";
import { triageDraft, type TriageDraft } from "./triage-drafts";
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
  const [drafts, setDrafts] = useState<ReadonlyMap<string, TriageDraft>>(() => new Map());
  const [busy, setBusy] = useState<{ id: string; action: "promote" | "suggest" } | null>(null);
  const [snoozeTarget, setSnoozeTarget] = useState<SnoozeTarget | null>(null);
  const [mergeTarget, setMergeTarget] = useState<MergeTarget | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const discarding = useRef(new Set<string>());
  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const selected = selectedId === null ? null : (items.find((item) => item.id === selectedId) ?? items[0] ?? null);
  const snoozedCount = data?.snoozedCount ?? 0;
  const forgetDraft = useCallback((id: string) => {
    setDrafts((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

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
      forgetDraft(item.id);
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
  }, [applyChange, forgetDraft, items, refreshAffected, router, toast]);

  const restore = useCallback(async (item: InboxItem) => {
    try {
      const { item: restored } = await api<{ item: InboxItem }>(`/api/inbox/${item.id}/restore`, { method: "POST" });
      await applyChange({ type: "restored", item: restored });
      setSelectedId(restored.id);
      refreshAffected();
      return true;
    } catch (cause) {
      toast(textInEveryLocale((locale) => localizedApiError(cause, locale, INBOX_COPY[locale].toast.undoFailed)), { tone: "danger" });
      return false;
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
      action: { label: textInEveryLocale((locale) => INBOX_COPY[locale].toast.undo), onClick: () => restore(item) },
    });
  }, [applyChange, items, refreshAffected, restore, toast]);

  const unsnooze = useCallback(async (item: InboxItem, source: "undo" | "later") => {
    try {
      const { item: returned } = await api<{ item: InboxItem }>(`/api/inbox/${item.id}/unsnooze`, { method: "POST" });
      await applyChange({ type: "unsnoozed", item: returned });
      refreshAffected();
      if (source === "undo") setSelectedId(returned.id);
      else toast(textInEveryLocale((locale) => INBOX_COPY[locale].toast.broughtBack), { tone: "ok" });
      return true;
    } catch (cause) {
      const fallback = source === "undo" ? "undoFailed" : "bringBackFailed";
      toast(textInEveryLocale((locale) => localizedApiError(cause, locale, INBOX_COPY[locale].toast[fallback])), { tone: "danger" });
      return false;
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
      action: { label: textInEveryLocale((locale) => INBOX_COPY[locale].toast.undo), onClick: () => unsnooze(snoozed, "undo") },
    });
  }, [applyChange, items, refreshAffected, toast, unsnooze]);

  const merged = useCallback((item: InboxItem, note: Note) => {
    forgetDraft(item.id);
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
  }, [applyChange, forgetDraft, items, mutateGlobal, refreshAffected, router, toast]);

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

  useInboxCommands({ busy: busy !== null, discard, items, openSnooze, selected, view, setSelectedId, setDetailOpen, titleRef });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-12 pt-5 sm:px-6 lg:px-10 lg:pt-10">
      <DocumentTitle title={copy.title} />
      <InboxHeading count={data?.count} error={error && !data ? error : null} onRetry={() => void mutate()} />

      {isLoading && !data ? <InboxSkeleton /> : null}

      {data ? (
        <InboxViewSwitch
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
            <InboxList items={items} selectedId={selected?.id} busy={busy !== null} onSelect={(id, keyboard) => {
              setSelectedId(id);
              setDetailOpen(true);
              if (keyboard) requestAnimationFrame(() => titleRef.current?.focus());
            }} />
          </div>
          <div className={`min-w-0 ${detailOpen ? "" : "hidden lg:block"}`}>
            <Button className="mb-3 lg:hidden" variant="ghost" onClick={() => setDetailOpen(false)}>{copy.backToList}</Button>
            {selected ? (
            <TriageEditor
              key={selected.id}
              item={selected}
              draft={triageDraft(selected, drafts.get(selected.id))}
              onDraftChange={(update) => setDrafts((current) => {
                const next = new Map(current);
                next.set(selected.id, update(triageDraft(selected, current.get(selected.id))));
                return next;
              })}
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
