"use client";

import { startCompletion } from "@codemirror/autocomplete";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror, { oneDarkTheme, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Paperclip, Heading, List, ListTodo, Code, Link2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, useToast } from "@/components/ui";
import { useTheme } from "@/components/shell/ThemeProvider";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import type { NoteRef, NoteTitleMatch } from "@/lib/types";
import { NOTES_COPY } from "./copy";
import { LINKS_COPY } from "./links-copy";
import { attachmentMarkdownAt } from "./markdown";
import { refreshNoteViews } from "./note-cache";
import { isComposing, wikiLinkCompletion, wikiLinkEnv, type FetchTitles } from "./wikilink-autocomplete";
import { formatTransaction, type FormatAction } from "./editor-format";
import { EDITOR_HEADER_COPY } from "./editor-header-copy";
import { liveLabels, liveMarkdown, liveRaw } from "./live-markdown";
import { compositionEdits, deferEdit, sourceChange } from "./composition-edits";
import { LIVE_EDITOR_COPY } from "./live-editor-copy";
import { liveTables } from "./live-tables";
import { editorLanguage } from "./editor-language";

const writingHighlight = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2], fontWeight: "700" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: "600" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "var(--accent)" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: [tags.processingInstruction, tags.meta], color: "var(--mute)" },
]);

// Completion keys come from wikiLinkCompletion, guarded against IME composition.
const BASIC_SETUP = { foldGutter: false, lineNumbers: false, highlightActiveLineGutter: false, highlightActiveLine: false, syntaxHighlighting: false, completionKeymap: false };

const fetchNoteTitles: FetchTitles = async (query, signal) =>
  (await api<{ notes: NoteTitleMatch[] }>(`/api/notes/titles?q=${encodeURIComponent(query)}&limit=12`, { signal })).notes;

export function MarkdownEditor({ noteId, value, onChange, onAppend, raw = false }: { noteId: string; value: string; onChange: (value: string) => void; onAppend: (markdown: string) => void; raw?: boolean }) {
  const { resolvedTheme } = useTheme();
  const { locale } = useLocale();
  const copy = useCopy(NOTES_COPY).editor;
  const formatCopy = useCopy(EDITOR_HEADER_COPY);
  const liveCopy = useCopy(LIVE_EDITOR_COPY);
  const linksCopy = useCopy(LINKS_COPY).completion;
  const { cache, mutate } = useSWRConfig();
  const { toast } = useToast();
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const [initialValue] = useState(value);
  const reportedValue = useRef(value);
  const changeHandler = useRef(onChange);
  useEffect(() => { changeHandler.current = onChange; }, [onChange]);
  const reportChange = useCallback((body: string) => {
    reportedValue.current = body;
    changeHandler.current(body);
  }, []);
  useEffect(() => {
    const view = editorRef.current?.view;
    if (!view || value === reportedValue.current) return;
    reportedValue.current = value;
    deferEdit(view, { kind: "change", changes: sourceChange(view.state.doc.toString(), value) });
  }, [value]);
  const fileRef = useRef<HTMLInputElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const element = dockRef.current;
    const body = bodyRef.current;
    const pane = element?.closest("section");
    const dock = () => {
      if (!element || !pane || !body) return;
      const bounds = pane.getBoundingClientRect();
      const bodyBounds = body.getBoundingClientRect();
      const top = Math.max(bounds.top, viewport?.offsetTop ?? 0);
      const bottom = Math.min(bounds.bottom, viewport ? viewport.offsetTop + viewport.height : window.innerHeight);
      element.style.setProperty("--editor-left", `${bounds.left}px`);
      element.style.setProperty("--editor-width", `${bounds.width}px`);
      element.style.setProperty("--editor-bottom", `${Math.max(0, window.innerHeight - bounds.bottom)}px`);
      element.style.setProperty("--editor-body-bottom", `${Math.max(0, window.innerHeight - bodyBounds.bottom)}px`);
      const keyboard = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      element.style.setProperty("--keyboard-offset", `${keyboard}px`);
      // iOS Safari draws its form bar above the keyboard without reporting its height,
      // so with a phone keyboard open the dock moves to the top of the visible area,
      // under the note header while that header is on screen.
      const keyboardOpen = keyboard > 120 && !window.matchMedia("(min-width: 1024px)").matches;
      element.dataset.keyboard = keyboardOpen ? "open" : "closed";
      if (keyboardOpen) {
        const header = pane.firstElementChild?.getBoundingClientRect();
        element.style.setProperty("--dock-top", `${header && header.bottom > top ? Math.min(header.bottom, bottom) : top}px`);
      }
      const toolbar = element.firstElementChild?.getBoundingClientRect();
      const within = toolbar && toolbar.top >= top && toolbar.bottom <= bottom;
      element.style.visibility = within && (keyboardOpen || (toolbar.top >= bodyBounds.top && toolbar.bottom <= bodyBounds.bottom)) ? "" : "hidden";
    };
    const resize = new ResizeObserver(dock);
    if (pane) resize.observe(pane);
    if (body) resize.observe(body);
    const intersection = new IntersectionObserver(dock, { root: pane });
    if (body) intersection.observe(body);
    dock();
    pane?.addEventListener("scroll", dock);
    window.addEventListener("resize", dock);
    viewport?.addEventListener("resize", dock);
    viewport?.addEventListener("scroll", dock);
    return () => { resize.disconnect(); intersection.disconnect(); pane?.removeEventListener("scroll", dock); window.removeEventListener("resize", dock); viewport?.removeEventListener("resize", dock); viewport?.removeEventListener("scroll", dock); };
  }, []);
  const [uploading, setUploading] = useState(false);
  // The failure itself, not its text, so a language switch re-renders the message.
  const [uploadFailure, setUploadFailure] = useState<{ error: unknown } | null>(null);
  const baseExtensions = useMemo(() => [
    editorLanguage(),
    ...compositionEdits,
    ...liveMarkdown(),
    ...liveTables(),
    ...wikiLinkCompletion(fetchNoteTitles),
    EditorView.lineWrapping,
    // Highest precedence: the light/dark base theme comes first in the extension list and would otherwise win.
    Prec.highest(EditorView.theme({
      "&": { backgroundColor: "var(--card)", color: "var(--ink)" },
      ".cm-scroller": { fontFamily: "var(--font-sans)", fontSize: "var(--text-read-size)", lineHeight: "var(--text-read-leading)" },
      // lineWrapping resets word-break; restore the global Korean rule so words never split mid-syllable.
      ".cm-content, .cm-lineWrapping": { wordBreak: "keep-all", overflowWrap: "anywhere" },
      ".cm-content": { minHeight: "24rem", padding: "1rem 0 6rem", caretColor: "var(--focus)" },
      // Keep the drawn caret's negative margin inside the scroller at the start of a line.
      ".cm-line": { padding: "0 0.25rem" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--focus)", borderLeftWidth: "2px" },
      "&.cm-focused": { outline: "1px solid var(--mute)", outlineOffset: "2px", backgroundColor: "var(--desk)" },
    })),
  ], []);
  // The link is already in the body; get-or-create never duplicates a note the title list did not show (archived).
  const createLinkedNote = useCallback(async (title: string) => {
    try {
      await api<{ note: NoteRef }>("/api/notes/by-title", { method: "POST", json: { title } });
    } catch {
      toast(textInEveryLocale((locale) => LINKS_COPY[locale].completion.createFailed(title)), { tone: "danger" });
      return;
    }
    await refreshNoteViews({ cache, mutate });
  }, [cache, mutate, toast]);
  // A new list reconfigures the live editor in place, as a theme change does; text, selection and undo history stay.
  const extensions = useMemo(() => [
    ...baseExtensions,
    liveRaw.of(raw),
    ...(raw ? [] : [syntaxHighlighting(writingHighlight)]),
    liveLabels.of(liveCopy),
    EditorState.phrases.of(copy.phrases),
    EditorView.contentAttributes.of({ "aria-label": copy.bodyLabel }),
    wikiLinkEnv.of({ createLabel: linksCopy.create, onCreate: (title) => void createLinkedNote(title) }),
  ], [baseExtensions, raw, copy, liveCopy, linksCopy, createLinkedNote]);

  const upload = async (file: File) => {
    setUploading(true);
    setUploadFailure(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("noteId", noteId);
      const attachment = await api<{ markdown: string }>("/api/attachments", { method: "POST", body: form });
      const view = editorRef.current?.view;
      if (view) {
        deferEdit(view, { kind: "command", selection: view.state.selection, run(current, selection) {
          const at = selection.main.head;
          current.dispatch({ changes: { from: at, insert: attachmentMarkdownAt(current.state.doc.toString(), at, attachment.markdown) } });
          current.focus();
        } });
      } else {
        onAppend(attachment.markdown);
      }
    } catch (error) {
      setUploadFailure({ error });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const format = (action: FormatAction) => {
    const view = editorRef.current?.view;
    if (!view) return;
    deferEdit(view, { kind: "command", selection: view.state.selection, run(current, selection) {
      current.dispatch(formatTransaction(current.state.update({ selection }).state, action));
      current.focus();
      if (action === "wiki") startCompletion(current);
    } });
  };

  return (
    <div className="bg-card">
        <input
          ref={fileRef}
          className="sr-only"
          type="file"
          aria-label={copy.attachLabel}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }}
        />
      {uploadFailure ? <p role="alert" className="border-b border-line bg-danger-soft px-3 py-2 text-sm text-danger">{localizedApiError(uploadFailure.error, locale, copy.uploadFailed)}</p> : null}
      {/* Dark keeps One Dark's editor chrome (selection, panels, tooltips) but not its code-syntax colours. */}
      <div ref={bodyRef} className="px-1">
        <CodeMirror ref={editorRef} value={initialValue} theme={resolvedTheme === "dark" ? oneDarkTheme : "light"} extensions={extensions} onChange={reportChange} basicSetup={BASIC_SETUP} />
      </div>
      <div ref={dockRef} className="editor-format-dock pointer-events-none z-20 flex justify-center px-2">
        <div role="toolbar" aria-label={formatCopy.format} className="pointer-events-auto flex items-center gap-1 rounded-card border border-line bg-card p-1 shadow-card">
          {([
            ["heading", Heading], ["bullet", List], ["task", ListTodo], ["code", Code], ["wiki", Link2],
          ] as const).map(([action, Icon]) => <Button key={action} iconOnly variant="ghost" className="min-h-touch min-w-touch" aria-label={formatCopy[action]} title={formatCopy[action]}
            onPointerDown={(event) => event.preventDefault()} onClick={() => format(action)}><Icon aria-hidden className="size-4" /></Button>)}
          <Button iconOnly variant="ghost" className="min-h-touch min-w-touch" loading={uploading} aria-label={copy.attachLabel} title={copy.attachLabel}
            onPointerDown={(event) => event.preventDefault()} onClick={() => { if (!isComposing(editorRef.current?.view)) fileRef.current?.click(); }}><Paperclip aria-hidden className="size-4" /></Button>
        </div>
      </div>
    </div>
  );
}
