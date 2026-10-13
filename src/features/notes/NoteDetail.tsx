"use client";

import { Archive, Check, History, LoaderCircle, Pin, RotateCcw, Trash2, Tags } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, cn, EmptyState, Input, Sheet, SkeletonLines, useToast } from "@/components/ui";
import { sourceEvidence } from "@/features/search/source-passage";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import { formatDate, formatDateTime } from "@/lib/i18n/format-date";
import type { TaskToggle } from "@/lib/tasks";
import type { Note, NoteLinks } from "@/lib/types";
import { DailyNav } from "./DailyNav";
import { MarkdownEditor } from "./MarkdownEditor";
import { MarkdownPreview } from "./MarkdownPreview";
import { NoteConnections } from "./NoteConnections";
import { RevisionHistoryDialog, type RestoreOutcome } from "./RevisionHistoryDialog";
import { NOTES_COPY } from "./copy";
import { forgetNoteDraft, getNoteDraft } from "./draft-store";
import { refreshNoteViews } from "./note-cache";
import { mergeTaskToggle } from "./note-draft";
import { PurgeNoteDialog } from "./trash-actions";
import { ShareNoteDialog } from "./ShareNoteDialog";
import { displayNoteTitle } from "./display-title";
import { EDITOR_HEADER_COPY } from "./editor-header-copy";
import { NoteMoreMenu } from "./NoteMoreMenu";
import { TagEditor } from "./TagEditor";
import { mergeCommaItems } from "./comma-items";

export function NoteDetail({ noteId }: { noteId: string }) {
  const copy = useCopy(NOTES_COPY);
  const detail = useSWR<{ note: Note }>(`/api/notes/${noteId}`, { revalidateOnFocus: true });
  if (detail.isLoading) return <section className="min-w-0 flex-1 p-5"><SkeletonLines lines={8} /></section>;
  if (detail.error || !detail.data) return <section className="min-w-0 flex-1 p-5"><EmptyState title={copy.detail.openFailedTitle} description={copy.detail.openFailedDescription} action={<Button onClick={() => void detail.mutate()}>{copy.retry}</Button>} /></section>;
  return <LoadedNote note={detail.data.note} checking={detail.isValidating} refresh={() => detail.mutate()} />;
}

function useDraft(note: Note) {
  const { mutate, cache } = useSWRConfig();
  const { toast } = useToast();
  const controller = useMemo(() => getNoteDraft(note, async (id, value) => {
    const { note: saved } = await api<{ note: Note }>(`/api/notes/${id}`, { method: "PATCH", json: value });
    void mutate(`/api/notes/${id}`, { note: saved }, { revalidate: false });
    void refreshNoteViews({ cache, mutate });
    return saved;
  }), [note, mutate, cache]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => controller.hydrate(note), [controller, note]);
  useEffect(() => {
    if (snapshot.state !== "dirty") return;
    const timer = window.setTimeout(() => void controller.flush(), 700);
    return () => window.clearTimeout(timer);
  }, [controller, snapshot.state, snapshot.version]);
  // Keep both translations; a switch must not re-run the cleanup below, which flushes the draft.
  const reportLeaveFailure = useEffectEvent(() => {
    toast(textInEveryLocale((locale) => NOTES_COPY[locale].detail.leaveSaveFailed), { tone: "danger", durationMs: 0 });
  });
  useEffect(() => () => {
    void controller.flush().then((saved) => {
      if (!saved) reportLeaveFailure();
    });
  }, [controller]);
  return { controller, snapshot };
}

function LoadedNote({ note, checking, refresh }: { note: Note; checking: boolean; refresh: () => Promise<unknown> }) {
  const router = useRouter();
  const params = useSearchParams();
  const copy = useCopy(NOTES_COPY);
  const { mutate: mutateAll, cache } = useSWRConfig();
  const { toast } = useToast();
  const { controller, snapshot } = useDraft(note);
  const sourceKey = params.has("line") ? JSON.stringify([params.get("line"), params.get("at")]) : null;
  const [view, setView] = useState<{ sourceKey: string | null; mode: "edit" | "preview" }>({ sourceKey, mode: sourceKey === null ? "edit" : "preview" });
  // A new source link into an already open note must also open preview; an explicit mode choice wins for that link.
  const mode = view.sourceKey === sourceKey ? view.mode : sourceKey === null ? "edit" : "preview";
  const evidence = sourceEvidence(params.get("line"), params.get("at"), note.updatedAt, snapshot.state !== "saved" || snapshot.body !== note.body, checking);
  // Read when a task toggle settles, which may be after the preview has been left for the editor.
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const [actionBusy, setActionBusy] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const { locale } = useLocale();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [aliasesOpen, setAliasesOpen] = useState(false);
  const headerCopy = useCopy(EDITOR_HEADER_COPY);
  // Subscribe to the existing connections cache; this header never starts a request.
  const links = useSWR<NoteLinks>(`/api/notes/${note.id}/links`, {
    revalidateOnMount: false, revalidateOnFocus: false, revalidateOnReconnect: false,
  }).data;
  // Bumped by a version restore: remounting the editor and fields drops their undo history and local field drafts.
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  const refreshLists = () => refreshNoteViews({ cache, mutate: mutateAll });
  const patchFlag = async (patch: Partial<Pick<Note, "pinned" | "archived">>) => {
    setActionBusy(true);
    try {
      if (!await controller.flush()) {
        toast(textInEveryLocale((locale) => NOTES_COPY[locale].detail.saveFirst), { tone: "danger" });
        return;
      }
      await api(`/api/notes/${note.id}`, { method: "PATCH", json: patch });
      await Promise.all([refresh(), refreshLists()]);
    } catch (error) { toast(textInEveryLocale((locale) => localizedApiError(error, locale, NOTES_COPY[locale].detail.updateFailed)), { tone: "danger" }); }
    finally { setActionBusy(false); }
  };
  const trash = async () => {
    setActionBusy(true);
    try {
      if (!await controller.flush()) {
        toast(textInEveryLocale((locale) => NOTES_COPY[locale].detail.trashBlocked), { tone: "danger" });
        return;
      }
      await api(`/api/notes/${note.id}`, { method: "DELETE" });
      forgetNoteDraft(note.id);
      await refreshNoteViews({ cache, mutate: mutateAll }, { removedId: note.id });
      router.push("/notes?view=trash");
      const id = note.id;
      toast(textInEveryLocale((locale) => NOTES_COPY[locale].detail.trashed), {
        action: { label: textInEveryLocale((locale) => NOTES_COPY[locale].detail.undo), onClick: () => void undoTrash(id) },
      });
    } catch (error) { toast(textInEveryLocale((locale) => localizedApiError(error, locale, NOTES_COPY[locale].detail.trashFailed)), { tone: "danger" }); }
    finally { setActionBusy(false); }
  };
  // Runs from the toast after this view has unmounted, so it only uses app-wide router, cache and toast handles.
  const undoTrash = async (id: string) => {
    try {
      const { note: restored } = await api<{ note: Note }>(`/api/notes/${id}/restore`, { method: "POST" });
      forgetNoteDraft(id);
      await mutateAll(`/api/notes/${id}`, { note: restored }, { revalidate: false });
      await refreshLists();
      router.push(`/notes/${id}`);
    } catch (error) { toast(textInEveryLocale((locale) => localizedApiError(error, locale, NOTES_COPY[locale].detail.restoreFailed)), { tone: "danger" }); }
  };
  const restoreRevision = async (revisionId: string): Promise<RestoreOutcome> => {
    // Settle the draft first so no autosave lands after the restore and overwrites it.
    if (!await controller.flush()) return { ok: false, reason: "unsaved" };
    let restored: Note;
    try {
      ({ note: restored } = await api<{ note: Note }>(`/api/notes/${note.id}/revisions/${revisionId}/restore`, { method: "POST" }));
    } catch (error) {
      return { ok: false, reason: "failed", error };
    }
    controller.replace(restored);
    setRestoreEpoch((epoch) => epoch + 1);
    setHistoryOpen(false);
    toast(textInEveryLocale((locale) => NOTES_COPY[locale].history.restored), { tone: "ok" });
    void mutateAll(`/api/notes/${note.id}`, { note: restored }, { revalidate: false });
    void mutateAll(`/api/notes/${note.id}/revisions`);
    void refreshLists();
    return { ok: true };
  };
  const applyTaskToggle = (saved: Note, toggle: TaskToggle) => {
    const merge = mergeTaskToggle(controller.getSnapshot(), toggle, modeRef.current === "preview");
    if (merge.kind === "replace") controller.replace(saved);
    else if (merge.kind === "update") controller.update({ body: merge.body });
    void mutateAll(`/api/notes/${note.id}`, { note: saved }, { revalidate: false });
    void refreshLists();
  };
  const restore = async () => {
    setActionBusy(true);
    try {
      await api(`/api/notes/${note.id}/restore`, { method: "POST" });
      forgetNoteDraft(note.id);
      await refreshLists();
      router.push(`/notes/${note.id}`);
      await refresh();
    } catch (error) { toast(textInEveryLocale((locale) => localizedApiError(error, locale, NOTES_COPY[locale].detail.restoreFailed)), { tone: "danger" }); }
    finally { setActionBusy(false); }
  };
  const history = <RevisionHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} noteId={note.id}
    currentBody={note.deletedAt ? note.body : snapshot.body} readOnly={Boolean(note.deletedAt)} onRestore={restoreRevision} />;
  const modeControl = <div role="group" aria-label={copy.detail.modeLabel} className="flex shrink-0 rounded-ctl bg-canvas p-1 ring-1 ring-inset ring-line">{(["edit", "preview"] as const).map((value) => (
    <button key={value} type="button" aria-pressed={mode === value} className={cn("min-h-touch min-w-touch shrink-0 whitespace-nowrap rounded-ctl px-0.5 py-1.5 text-xs transition-colors lg:min-h-0 lg:px-3", mode === value ? "bg-card font-medium text-ink shadow-card ring-1 ring-line-strong" : "text-mute hover:text-ink")} onClick={() => setView({ sourceKey, mode: value })}>{copy.detail[value]}</button>
  ))}</div>;

  if (note.deletedAt) {
    const purgeDate = note.purgeAt ? formatDate(note.purgeAt, locale) : "";
    return (
      <section className="min-w-0 flex-1 overflow-y-auto p-4 pb-24 sm:p-6 lg:pb-6">
        <div className="mx-auto max-w-3xl">
          <Link href="/notes?view=trash" className="inline-flex min-h-touch items-center text-sm text-accent sm:min-h-0">{copy.detail.backToTrash}</Link>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">{displayNoteTitle(note, locale)}</h1>
          <div className="mt-4 rounded-card border border-line bg-warn-soft px-4 py-3">
            <div className="flex items-start gap-3">
              <Trash2 aria-hidden className="mt-0.5 size-5 shrink-0 text-warn" />
              <div className="min-w-0">
                <p className="font-medium text-ink">{copy.detail.trashedTitle}</p>
                <p className="mt-0.5 text-sm text-ink">{purgeDate ? <>{copy.detail.purgeOn(purgeDate)} </> : null}{copy.detail.trashedDescription}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 sm:pl-8">
              <Button variant="primary" className="min-h-touch sm:min-h-0" loading={actionBusy} leading={<RotateCcw aria-hidden className="size-4" />} onClick={() => void restore()}>{copy.detail.restore}</Button>
              <Button className="min-h-touch sm:min-h-0" disabled={actionBusy} leading={<History aria-hidden className="size-4" />} onClick={() => setHistoryOpen(true)}>{copy.history.open}</Button>
              <Button variant="danger" className="min-h-touch sm:min-h-0" disabled={actionBusy} onClick={() => setPurgeOpen(true)}>{copy.detail.purge}</Button>
            </div>
          </div>
        </div>
        {history}
        <PurgeNoteDialog noteId={note.id} open={purgeOpen} onOpenChange={setPurgeOpen} />
      </section>
    );
  }

  return (
    <section className="relative min-w-0 flex-1 overflow-y-auto bg-card pb-36 scrollbar-thin">
      <div className="py-2 sm:px-4">
        <div className="flex min-w-0 items-center lg:gap-1">
          <Link href="/notes" aria-label={copy.detail.backToList} title={copy.detail.backToList} className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center text-sm text-mute hover:text-ink lg:hidden"><span aria-hidden>←</span></Link>
          {note.dailyDate ? <DailyNav date={note.dailyDate} /> : null}
          {snapshot.state !== "failed" ? <SaveIndicator state={snapshot.state} error={snapshot.error} retry={() => void controller.retry()} compact={Boolean(note.dailyDate)} /> : null}
          <div className="ml-auto">{modeControl}</div>
          <Button variant="ghost" iconOnly className="min-h-touch min-w-touch" aria-label={copy.detail.pin} title={copy.detail.pin} aria-pressed={note.pinned} disabled={actionBusy} onClick={() => void patchFlag({ pinned: !note.pinned })}><Pin aria-hidden className={note.pinned ? "size-4 fill-current text-accent" : "size-4"} /></Button>
          {!note.archived ? <ShareNoteDialog noteId={note.id} beforeCreate={() => controller.flush()} /> : null}
          <NoteMoreMenu disabled={actionBusy} actions={[
            { label: note.archived ? copy.detail.unarchive : copy.detail.archive, icon: <Archive aria-hidden className="size-4" />, run: () => void patchFlag({ archived: !note.archived }) },
            { label: copy.history.open, icon: <History aria-hidden className="size-4" />, run: () => setHistoryOpen(true) },
            { label: copy.detail.aliases, icon: <Tags aria-hidden className="size-4" />, run: () => setAliasesOpen(true) },
            { label: copy.detail.moveToTrash, icon: <Trash2 aria-hidden className="size-4" />, danger: true, run: () => void trash() },
          ]} />
        </div>
        {snapshot.state === "failed" ? <SaveIndicator state={snapshot.state} error={snapshot.error} retry={() => void controller.retry()} /> : null}
      </div>
      <div className="mx-auto max-w-3xl px-4 pt-3 sm:px-8 lg:pt-6">
        <input aria-label={copy.detail.titleLabel} placeholder={copy.detail.titleLabel}
          className="w-full min-w-0 rounded-ctl border border-transparent bg-transparent px-1 py-2 text-2xl font-semibold tracking-tight text-ink placeholder:text-mute hover:border-line focus:outline-none focus:shadow-[inset_0_-2px_0_var(--focus)]"
          value={editingTitle ? snapshot.title : displayNoteTitle({ title: snapshot.title, dailyDate: note.dailyDate }, locale)}
          onFocus={() => setEditingTitle(true)} onBlur={() => setEditingTitle(false)}
          onChange={(event) => controller.update({ title: event.target.value })} />
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 px-1" key={restoreEpoch}>
          <TagEditor tags={snapshot.tags} onCommit={(tags) => controller.update({ tags })} />
          {snapshot.aliases.length ? <span className="text-xs text-mute">{headerCopy.aliases(snapshot.aliases.length)}</span> : null}
        </div>
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-mute">
          <span>{headerCopy.updated} <time dateTime={note.updatedAt}>{formatDateTime(note.updatedAt, locale)}</time></span>
          {links ? <><span>{headerCopy.outgoing(links.outgoing.length)}</span><span>{headerCopy.backlinks(links.backlinks.length)}</span></> : null}
        </p>
        {note.sourceUrl ? <p className="mt-2 flex min-w-0 items-center gap-2 text-sm">
          <span className="shrink-0 text-mute">{copy.detail.source}</span>
          <a href={note.sourceUrl} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate text-accent underline underline-offset-2 focus-ring">{note.sourceUrl}</a>
        </p> : null}
        {evidence.state !== "none" && evidence.state !== "ready" ? (
          <p role="status" className={cn("mt-3 rounded-ctl px-3 py-2 text-sm", evidence.state === "checking" ? "bg-desk text-mute" : "bg-warn-soft text-warn")}>{copy.detail.sourceEvidence[evidence.state]}</p>
        ) : null}
        <div className="mt-3">{mode === "edit" ? <MarkdownEditor key={restoreEpoch} noteId={note.id} value={snapshot.body} onChange={(body) => controller.update({ body })} onAppend={(markdown) => {
          const body = controller.getSnapshot().body;
          controller.update({ body: `${body}${body && !body.endsWith("\n") ? "\n" : ""}${markdown}` });
          void controller.flush().then((saved) => {
            if (!saved) toast(textInEveryLocale((locale) => NOTES_COPY[locale].detail.attachmentLinkFailed), { tone: "danger", durationMs: 0 });
          });
        }} /> : <MarkdownPreview inEditor body={snapshot.body} source={evidence.state === "ready" ? evidence : undefined} tasks={note.archived ? undefined : {
          noteId: note.id,
          // Line numbers are only the server's while the draft matches what it saved.
          editable: snapshot.state === "saved",
          onNoteChange: applyTaskToggle,
          onConflict: () => void refresh(),
        }} />}</div>
        <NoteConnections noteId={note.id} />
      </div>
      {history}
      <Sheet open={aliasesOpen} onOpenChange={setAliasesOpen} title={copy.detail.aliases} bodyClassName="px-4 py-3">
        <CommaField key={restoreEpoch} label={copy.detail.aliases} defaultValue={snapshot.aliases.join(", ")} placeholder={copy.detail.aliasesPlaceholder} onCommit={(aliases) => controller.update({ aliases })} />
      </Sheet>
    </section>
  );
}

function CommaField({ label, defaultValue, placeholder, onCommit }: { label: string; defaultValue: string; placeholder: string; onCommit: (items: string[]) => void }) {
  const [draft, setDraft] = useState({ base: defaultValue, value: defaultValue });
  if (draft.base !== defaultValue && draft.value === draft.base) {
    setDraft({ base: defaultValue, value: defaultValue });
  }
  return <Input label={label} value={draft.value} placeholder={placeholder}
    onChange={(event) => setDraft({ ...draft, value: event.target.value })} onBlur={(event) => {
    const values = mergeCommaItems(event.target.value, draft.base, defaultValue);
    setDraft({ base: values.join(", "), value: values.join(", ") });
    if (values.join(", ") !== defaultValue) onCommit(values);
  }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

function SaveIndicator({ state, error, retry, compact = false }: { state: string; error: unknown; retry: () => void; compact?: boolean }) {
  const { locale } = useLocale();
  const copy = useCopy(NOTES_COPY);
  if (state === "failed") return <div role="alert" data-save-state={state} className="order-last w-full rounded-ctl border border-danger/30 bg-danger-soft px-3 py-2 text-sm">
    <div className="flex items-center justify-between gap-2"><span className="font-medium text-danger">{copy.detail.saveFailed}</span><Button size="sm" className="min-h-touch sm:min-h-0" variant="ghost" onClick={retry}>{copy.retry}</Button></div>
    <p>{localizedApiError(error, locale, copy.detail.saveFailedDetail)}</p>
  </div>;
  const saving = state === "saving" || state === "dirty";
  // One live region whose text changes, so screen readers hear each save state.
  return <span role="status" data-save-state={state} aria-label={saving ? copy.detail.saving : copy.detail.saved} title={saving ? copy.detail.saving : copy.detail.saved}
    className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs", saving ? "text-warn" : "text-mute")}>
    {saving ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : <Check aria-hidden className="size-3.5" />}
    {/* A daily note's header also holds the date control, so on phones the state is its icon. */}
    <span className={compact ? "sr-only sm:not-sr-only" : "max-[375px]:sr-only"}>{saving ? copy.detail.saving : copy.detail.saved}</span>
  </span>;
}
