"use client";

import { Command } from "cmdk";
import { ArrowLeft, LoaderCircle, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import useSWR, { useSWRConfig } from "swr";
import { refreshNoteViews } from "@/features/notes/note-cache";
import { createNoteFromTemplate, TEMPLATES_KEY } from "@/features/settings/template-note";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { localDateKey } from "@/lib/i18n/format-date";
import type { NoteTemplate } from "@/lib/templates";
import type { NoteRef } from "@/lib/types";
import { useCopy, useLocale } from "@/components/i18n/LocaleProvider";
import { useModalDialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";
import { useToast } from "@/components/ui/Toast";
import { everyLocale, SHELL_COPY } from "./copy";
import { NoteCommands, RootCommands, TemplateCommands } from "./PaletteRows";
import { modKey } from "./shortcuts";
import { useTheme } from "./ThemeProvider";

/** "all" = commands + notes (⌘K); "notes" = note switcher only (⌘P). */
export type PaletteMode = "all" | "notes";

export type CommandPaletteProps = {
  open: boolean;
  mode: PaletteMode;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: PaletteMode) => void;
  /** Injected by ShellProvider; kept optional so the palette can render standalone. */
  onCapture?: () => void;
};

const NOTE_LIMIT = 12;
/** Recent notes shown above the commands when the ⌘K palette opens with an empty query. */
const RECENT_LIMIT = 5;

/** Note and create rows; the filter ranks them above commands so they lead once a query is typed. */
const isNoteRow = (value: string) => value.startsWith("note-") || value.startsWith("create-");

export function CommandPalette({ open, mode, onOpenChange, onModeChange, onCapture }: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { ref, onClose, onBackdropClick } = useModalDialog(open, onOpenChange, inputRef);
  const copy = useCopy(SHELL_COPY);

  return (
    <dialog
      ref={ref}
      data-command-palette
      onClose={onClose}
      // PaletteBody owns the mutation state; native exits honor its rendered busy signal.
      onCancel={(event) => {
        if (event.currentTarget.querySelector('[cmdk-list][aria-busy="true"]')) event.preventDefault();
      }}
      onClick={(event) => {
        if (!event.currentTarget.querySelector('[cmdk-list][aria-busy="true"]')) onBackdropClick(event);
      }}
      aria-label={mode === "notes" ? copy.palette.switcherLabel : copy.actions.palette}
      className="mx-auto mb-auto mt-[10dvh] w-[calc(100%-1.5rem)] max-w-xl overflow-hidden rounded-card border border-line bg-card p-0 text-ink shadow-pop backdrop:bg-scrim sm:mt-[14dvh]"
    >
      {open ? <PaletteBody mode={mode} onOpenChange={onOpenChange} onModeChange={onModeChange} onCapture={onCapture} inputRef={inputRef} /> : null}
    </dialog>
  );
}

type PaletteBodyProps = Omit<CommandPaletteProps, "open"> & { inputRef: RefObject<HTMLInputElement | null> };

/** Mounted only while open, so query/busy state starts fresh on every open. */
function PaletteBody({ mode, onOpenChange, onModeChange, onCapture, inputRef }: PaletteBodyProps) {
  const router = useRouter();
  const { cache, mutate } = useSWRConfig();
  const { toast } = useToast();
  const { theme, setTheme } = useTheme();
  const { locale } = useLocale();
  const copy = useCopy(SHELL_COPY);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  // Nested page of the ⌘K palette; the note switcher (⌘P) has none.
  const [page, setPage] = useState<"root" | "templates">("root");
  const onTemplates = mode === "all" && page === "templates";

  const trimmed = query.trim();
  const notes = useSWR<{ notes: NoteRef[] }>(onTemplates ? null : `/api/notes/titles?q=${encodeURIComponent(trimmed)}&limit=${NOTE_LIMIT}`, {
    revalidateOnFocus: false,
  });
  const templates = useSWR<{ templates: NoteTemplate[] }>(onTemplates ? TEMPLATES_KEY : null, { revalidateOnFocus: false });
  const templateList = templates.data?.templates ?? [];
  // cmdk keeps its selection on whatever mounted first (the manage row while templates load),
  // so the first template is selected explicitly once the list is there.
  const [selected, setSelected] = useState("");
  const firstTemplate = onTemplates && templates.data ? (templateList[0] ? `template-${templateList[0].id}` : "manage-templates") : null;
  const [landedOn, setLandedOn] = useState<string | null>(null);
  if (firstTemplate !== landedOn) {
    setLandedOn(firstTemplate);
    if (firstTemplate) setSelected(firstTemplate);
  }
  const noteList = useMemo(() => notes.data?.notes ?? [], [notes.data]);
  const noteTitles = useMemo(() => new Set(noteList.map((n) => n.title.toLowerCase())), [noteList]);
  const canCreate = trimmed.length > 0 && !notes.isValidating && !notes.error && !noteTitles.has(trimmed.toLowerCase());
  const recent = trimmed.length === 0;
  // The titles API orders by last update, so an empty query lists the recently edited notes.
  const noteRows = recent && mode === "all" ? noteList.slice(0, RECENT_LIMIT) : noteList;
  const mod = modKey();

  const run = (fn: () => void | Promise<void>) => {
    if (busy) return;
    void (async () => {
      setBusy(true);
      setFailure(null);
      try {
        await fn();
        onOpenChange(false);
      } catch (error) {
        setFailure({ cause: error });
      } finally {
        setBusy(false);
      }
    })();
  };

  const go = (href: string) => run(() => router.push(href));
  const createNote = (title?: string) =>
    run(async () => {
      const { note } = await api<{ note: NoteRef }>("/api/notes", { method: "POST", json: title ? { title } : {} });
      await refreshNoteViews({ cache, mutate });
      router.push(`/notes/${note.id}`);
    });
  const openDaily = () =>
    run(async () => {
      const { note } = await api<{ note: NoteRef }>("/api/daily", { method: "POST", json: { date: localDateKey() } });
      await refreshNoteViews({ cache, mutate });
      router.push(`/notes/${note.id}`);
    });
  const createFromTemplate = (template: NoteTemplate) =>
    run(async () => {
      const { note, bodyError } = await createNoteFromTemplate(template.body, localDateKey());
      await refreshNoteViews({ cache, mutate });
      if (bodyError) toast(everyLocale((c) => c.palette.templates.bodyFailed), { tone: "danger" });
      router.push(`/notes/${note.id}`);
    });
  const showPage = (next: "root" | "templates") => {
    setPage(next);
    setQuery("");
    inputRef.current?.focus();
  };
  // Escape, or Backspace in an empty field, leaves the template page before it closes the palette.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    // cmdk also binds Ctrl+P to its previous row. Own the palette mode commands
    // before that handler prevents them from reaching the shell.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ["k", "p"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      if (event.key.toLowerCase() === "p") onModeChange("notes");
      else {
        onModeChange("all");
        onOpenChange(false);
      }
      return;
    }
    if (busy && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!onTemplates) return;
    if (event.key === "Escape" || (event.key === "Backspace" && query === "")) {
      event.preventDefault();
      event.stopPropagation();
      showPage("root");
    }
  };

  return (
    <Command
      label={mode === "notes" ? copy.palette.switcherLabel : copy.actions.palette}
      loop
      value={selected}
      onValueChange={setSelected}
      shouldFilter={mode === "all"}
      filter={(value, search, keywords) => {
        const hay = [value, ...(keywords ?? [])].join(" ").toLowerCase();
        const needle = search.trim().toLowerCase();
        if (!needle) return 1;
        if (!hay.includes(needle)) return 0;
        // cmdk orders groups by their best score, so the note group outranks commands while searching.
        return isNoteRow(value) ? 2 : 1;
      }}
      className="flex max-h-[min(70dvh,32rem)] flex-col"
      onKeyDownCapture={onKeyDown}
    >
      <div className="flex items-center gap-2 border-b border-line px-3">
        {onTemplates ? (
          <button
            type="button"
            aria-label={copy.palette.templates.back}
            onClick={() => showPage("root")}
            className="-ml-1.5 flex size-touch shrink-0 items-center justify-center rounded-ctl text-mute hover:bg-line/60 hover:text-ink focus-ring sm:size-8"
          >
            <ArrowLeft aria-hidden className="size-4" />
          </button>
        ) : null}
        {busy || notes.isValidating || templates.isValidating ? (
          <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-mute" />
        ) : onTemplates ? null : (
          <Search aria-hidden className="size-4 shrink-0 text-mute" />
        )}
        <Command.Input
          ref={inputRef}
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder={onTemplates ? copy.palette.templates.placeholder : mode === "notes" ? copy.palette.switcherPlaceholder : copy.palette.placeholder}
          className="h-12 min-w-0 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-mute"
        />
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          {onTemplates ? null : mode === "all" ? (
            <button type="button" onClick={() => onModeChange("notes")} className="rounded-ctl px-1.5 py-0.5 text-xs text-mute hover:bg-line/60 hover:text-ink">
              {copy.palette.notesOnly}
            </button>
          ) : (
            <button type="button" onClick={() => onModeChange("all")} className="rounded-ctl px-1.5 py-0.5 text-xs text-mute hover:bg-line/60 hover:text-ink">
              {copy.palette.all}
            </button>
          )}
          <Kbd>esc</Kbd>
        </div>
      </div>

      {failure ? <p role="alert" className="border-b border-line bg-danger-soft px-4 py-3 text-sm text-danger">{localizedApiError(failure.cause, locale, copy.palette.failed)}</p> : null}
      <Command.List aria-busy={busy} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5 scrollbar-thin">
        <Command.Empty className="px-3 py-8 text-center text-sm text-mute">
          {onTemplates ? copy.palette.empty : notes.isValidating ? copy.palette.searching : notes.error ? copy.palette.loadFailed : copy.palette.empty}
        </Command.Empty>

        {onTemplates ? <TemplateCommands templates={templateList} loading={!templates.data} failed={Boolean(templates.error && !templates.data)} onCreate={createFromTemplate} go={go} /> : null}

        {!onTemplates && (noteRows.length > 0 || canCreate) ? <NoteCommands notes={noteRows} recent={recent} canCreate={canCreate} query={trimmed} go={go} onCreate={createNote} /> : null}

        {mode === "all" && !onTemplates ? (
          <RootCommands
            onCapture={() => run(() => onCapture?.())}
            onNewNote={() => createNote()}
            onTemplates={() => showPage("templates")}
            onDaily={openDaily}
            go={go}
            theme={theme}
            onTheme={(value) => run(() => setTheme(value))}
          />
        ) : null}
      </Command.List>

      <div className="hidden items-center gap-3 border-t border-line px-3 py-1.5 text-xs text-mute sm:flex">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> {copy.palette.hints.move}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd> {copy.palette.hints.open}
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <Kbd>{mod}</Kbd>
          <Kbd>P</Kbd> {copy.palette.notesOnly}
        </span>
      </div>
    </Command>
  );
}
