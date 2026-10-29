"use client";

import { Check, FilePlus2, FileText, Pin, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, EmptyState, Input, SkeletonLines, TagBadge, useToast } from "@/components/ui";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import { formatDate } from "@/lib/i18n/format-date";
import type { NoteListItem, NoteRef, TagCount } from "@/lib/types";
import { refreshNoteViews } from "./note-cache";
import { NOTES_COPY } from "./copy";
import { calendarDaysAgo } from "./relative-day";
import { TrashBar } from "./trash-actions";
import { daysUntilPurge } from "./trash-retention";
import { displayNoteTitle } from "./display-title";

type NotesPage = { notes: NoteListItem[]; nextCursor: string | null };
type View = "all" | "pinned" | "archived" | "trash";

export function NoteList({ selectedId }: { selectedId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { mutate: mutateAll, cache } = useSWRConfig();
  const { toast } = useToast();
  const copy = useCopy(NOTES_COPY);
  const { locale } = useLocale();
  const q = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const rawView = params.get("view");
  const view: View = rawView === "pinned" || rawView === "archived" || rawView === "trash" ? rawView : "all";
  const tags = useSWR<{ tags: TagCount[] }>("/api/tags");
  const getKey = (index: number, previous: NotesPage | null) => {
    if (previous && !previous.nextCursor) return null;
    const query = new URLSearchParams({ limit: "30" });
    if (q) query.set("q", q);
    if (tag) query.set("tag", tag);
    if (view === "pinned") query.set("pinned", "1");
    if (view === "archived") query.set("archived", "1");
    if (view === "trash") query.set("trash", "1");
    if (index > 0 && previous?.nextCursor) query.set("cursor", previous.nextCursor);
    return `/api/notes?${query}`;
  };
  const list = useSWRInfinite<NotesPage>(getKey, { revalidateFirstPage: true, keepPreviousData: true });
  const notes = list.data?.flatMap((page) => page.notes) ?? [];
  const hasMore = Boolean(list.data?.at(-1)?.nextCursor);
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value); else next.delete(key);
    router.replace(`${pathname}?${next}`, { scroll: false });
  };
  const create = async () => {
    try {
      const { note } = await api<{ note: NoteRef }>("/api/notes", { method: "POST", json: {} });
      await refreshNoteViews({ cache, mutate: mutateAll });
      router.push(`/notes/${note.id}`);
    } catch (error) {
      toast(textInEveryLocale((locale) => localizedApiError(error, locale, NOTES_COPY[locale].list.createFailed)), { tone: "danger" });
    }
  };

  return (
    <aside className={`${selectedId ? "hidden lg:flex" : "flex"} w-full shrink-0 flex-col border-r border-line bg-desk lg:w-80 xl:w-96`} aria-label={copy.list.label}>
      <header className="border-b border-line p-4">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-xl font-semibold">{copy.list.heading}</h1>
          <Button variant="primary" size="sm" className="max-lg:min-h-touch" leading={<FilePlus2 aria-hidden className="size-4" />} onClick={() => void create()}>{copy.list.newNote}</Button>
        </div>
        {/* Below lg the tag filter shares the search row so the first note sits higher on a phone. */}
        <div className="flex items-end gap-2 lg:flex-col lg:items-stretch lg:gap-3">
          <Input wrapperClassName="min-w-0 flex-1 lg:flex-none" className="max-lg:min-h-touch" label={copy.list.searchLabel} placeholder={copy.list.searchPlaceholder} value={q} leading={<Search aria-hidden />} onChange={(event) => setParam("q", event.target.value)} trailing={q ? <button type="button" className="control-target inline-flex items-center justify-center" aria-label={copy.list.clearSearch} onClick={() => setParam("q", "")}><X aria-hidden className="size-4" /></button> : null} />
          {(tags.data?.tags.length ?? 0) > 0 ? (
            <label className="flex w-32 shrink-0 flex-col gap-1.5 text-xs text-mute lg:w-auto"><span>{copy.list.tagFilter}</span>
              <select className="h-10 min-w-0 flex-1 rounded-ctl border border-control-boundary bg-card px-2 text-sm text-ink max-lg:min-h-touch lg:h-auto lg:py-1.5" value={tag} onChange={(event) => setParam("tag", event.target.value)}>
                <option value="">{copy.list.allTags}</option>
                {tags.data?.tags.map((item) => <option key={item.tag} value={item.tag}>{item.tag} ({item.count})</option>)}
              </select>
            </label>
          ) : null}
        </div>
        <div role="group" className="mt-3 flex rounded-ctl bg-canvas p-1 ring-1 ring-inset ring-line" aria-label={copy.list.viewsLabel}>
          {(["all", "pinned", "archived", "trash"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={view === value} onClick={() => setParam("view", value === "all" ? "" : value)} className={`control-target flex-1 rounded-ctl px-3 py-1.5 text-sm transition-colors max-lg:min-h-touch ${view === value ? "bg-card font-medium text-ink shadow-card ring-1 ring-line-strong" : "text-mute hover:text-ink"}`}>{copy.list.views[value]}</button>
          ))}
        </div>
        {tags.error ? <button type="button" className="control-target mt-2 min-h-touch text-xs text-danger underline lg:min-h-0" onClick={() => void tags.mutate()}>{copy.list.tagsFailed}</button> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        {view === "trash" ? <TrashBar selectedId={selectedId} /> : null}
        {list.isLoading ? <div className="p-3"><SkeletonLines lines={6} /></div> : null}
        {list.error ? <EmptyState title={copy.list.loadFailedTitle} description={copy.list.loadFailedDescription} action={<Button size="sm" onClick={() => void list.mutate()}>{copy.retry}</Button>} /> : null}
        {!list.isLoading && !list.error && notes.length === 0 ? <EmptyState icon={FileText} title={view === "trash" ? copy.list.trashEmpty : copy.list.empty} description={q || tag ? copy.list.emptyFiltered : view === "trash" ? undefined : copy.list.emptyStart} action={view !== "trash" ? <Button size="sm" onClick={() => void create()}>{copy.list.newNote}</Button> : undefined} /> : null}
        <ul className="space-y-1">
          {notes.map((note) => (
            <li key={note.id}>
              <Link href={`/notes/${note.id}${params.size ? `?${params}` : ""}`} aria-current={selectedId === note.id ? "page" : undefined} className={`block rounded-card border px-3 py-3 transition-colors ${selectedId === note.id ? "border-line-strong bg-canvas" : "border-transparent hover:border-line hover:bg-card"}`}>
                <div className="flex items-start gap-2"><h2 className="min-w-0 flex-1 truncate font-medium">{displayNoteTitle(note, locale)}</h2>{selectedId === note.id ? <Check aria-hidden className="size-4 shrink-0" /> : null}{note.pinned ? <Pin aria-label={copy.list.pinned} className="size-3.5 shrink-0 text-accent" /> : null}</div>
                {note.excerpt ? <p className="mt-1 line-clamp-2 text-sm text-mute">{note.excerpt}</p> : null}
                <div className="mt-2 flex items-center gap-1 overflow-hidden">{note.tags.slice(0, 2).map((item) => <TagBadge key={item} tag={item} />)}<ListDate note={note} trash={view === "trash"} /></div>
              </Link>
            </li>
          ))}
        </ul>
        {hasMore ? <Button className="mt-2 w-full" size="sm" loading={list.isValidating} onClick={() => void list.setSize(list.size + 1)}>{copy.list.loadMore}</Button> : null}
      </div>
    </aside>
  );
}

/** Trashed notes show the days left before the purge instead of the last edit. */
function ListDate({ note, trash }: { note: NoteListItem; trash: boolean }) {
  const copy = useCopy(NOTES_COPY);
  const { locale } = useLocale();
  const days = trash ? daysUntilPurge(note.purgeAt) : null;
  if (days !== null && note.purgeAt) {
    return <time dateTime={note.purgeAt} title={formatDate(note.purgeAt, locale)} className="ml-auto shrink-0 text-xs text-mute">{copy.list.purgeIn(days)}</time>;
  }
  return <time dateTime={note.updatedAt} className="ml-auto shrink-0 text-xs text-mute">{copy.list.updated(calendarDaysAgo(note.updatedAt))}</time>;
}
