"use client";

import { useRouter } from "next/navigation";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type HTMLAttributes } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCopy } from "@/components/i18n";
import { cn, useToast } from "@/components/ui";
import { sourceBlockAttributes, sourceBlockForLine, type SourceBlock } from "@/features/search/source-passage";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import { parseTasks, type TaskItem, type TaskToggle } from "@/lib/tasks";
import type { Note, NoteRef } from "@/lib/types";
import { NOTES_COPY } from "./copy";
import { PREVIEW_TASK_COPY } from "./daily-copy";
import { expandWikiLinks, wikiTitleFromHref } from "./markdown";
import { taskConflictReason, taskItemLabel, taskItemLine, type TaskConflictReason } from "./preview-task";

/** Opt-in task checkboxes. Without it (or with `editable: false`) every checkbox stays read-only. */
export type PreviewTasks = {
  noteId: string;
  editable: boolean;
  /** The saved note returned by a successful toggle, and the toggle it applied. */
  onNoteChange: (note: Note, toggle: TaskToggle) => void;
  /** A `409` rolled the checkbox back; the owner may reload the note. */
  onConflict?: (reason: TaskConflictReason) => void;
};

type TaskControls = {
  tasks: ReadonlyMap<number, TaskItem>;
  pending: ReadonlyMap<number, boolean>;
  toggle: (task: TaskItem, done: boolean) => void;
};

const NO_TASKS: ReadonlyMap<number, TaskItem> = new Map();
const TaskControlsContext = createContext<TaskControls | null>(null);
const TaskItemContext = createContext<{ line: number; label: string } | null>(null);

function TaskListItem({ node, children, ...props }: ComponentProps<"li"> & ExtraProps) {
  const line = taskItemLine(node);
  const item = line !== null && node ? { line, label: taskItemLabel(node) } : null;
  return <li {...props}><TaskItemContext.Provider value={item}>{children}</TaskItemContext.Provider></li>;
}

function TaskCheckbox(props: ComponentProps<"input"> & ExtraProps) {
  const controls = useContext(TaskControlsContext);
  const item = useContext(TaskItemContext);
  const task = item ? controls?.tasks.get(item.line) : undefined;
  // Only a task the parser also found, in the state the renderer shows, can be toggled by line.
  if (!controls || !item || !task || props.type !== "checkbox" || task.done !== Boolean(props.checked)) {
    const input = { ...props };
    delete input.node;
    return <input {...input} />;
  }
  const pending = controls.pending.get(task.line);
  const checked = pending ?? task.done;
  return (
    <label className="-mx-2 -my-1.5 inline-flex cursor-pointer items-center px-2 py-1.5 align-middle">
      <input
        type="checkbox"
        checked={checked}
        aria-label={item.label || undefined}
        aria-busy={pending !== undefined || undefined}
        aria-disabled={pending !== undefined || undefined}
        onChange={() => { if (pending === undefined) controls.toggle(task, !checked); }}
        className="size-4 cursor-pointer accent-accent aria-busy:cursor-progress aria-busy:opacity-60"
      />
    </label>
  );
}

const TASK_COMPONENTS: Components = { li: TaskListItem, input: TaskCheckbox };

function SourceBlockRenderer({ node, children, ...props }: HTMLAttributes<HTMLElement> & ExtraProps) {
  return createElement(node?.tagName ?? "p", { ...props, ...sourceBlockAttributes(node) }, children);
}

function SourceTaskListItem(props: ComponentProps<"li"> & ExtraProps) {
  return <TaskListItem {...props} {...sourceBlockAttributes(props.node)} />;
}

/** Shared with the renderer's neighbor tests; only a version-checked source view enables anchors. */
export const SOURCE_COMPONENTS: Components = {
  p: SourceBlockRenderer,
  h1: SourceBlockRenderer,
  h2: SourceBlockRenderer,
  h3: SourceBlockRenderer,
  h4: SourceBlockRenderer,
  h5: SourceBlockRenderer,
  h6: SourceBlockRenderer,
  li: SourceBlockRenderer,
  pre: SourceBlockRenderer,
  blockquote: SourceBlockRenderer,
  table: SourceBlockRenderer,
  tr: SourceBlockRenderer,
  hr: SourceBlockRenderer,
};

/** Toggles run one at a time, so each returned note already contains the toggles before it. */
function useTaskControls(body: string, tasks: PreviewTasks | undefined): TaskControls | null {
  const { toast } = useToast();
  const enabled = tasks?.editable === true;
  const noteId = tasks?.noteId;
  const latest = useRef(tasks);
  useEffect(() => { latest.current = tasks; });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [pending, setPending] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const parsed = useMemo(() => (enabled ? new Map(parseTasks(body).map((task) => [task.line, task])) : NO_TASKS), [body, enabled]);

  const toggle = useCallback((task: TaskItem, done: boolean) => {
    if (!noteId) return;
    setPending((current) => new Map(current).set(task.line, done));
    queue.current = queue.current.then(async () => {
      try {
        const { note } = await api<{ note: Note }>("/api/tasks/toggle", {
          method: "POST",
          json: { noteId, line: task.line, expectedText: task.text, done },
        });
        latest.current?.onNoteChange(note, { line: task.line, expectedText: task.text, done });
      } catch (error) {
        const reason = taskConflictReason(error);
        toast(textInEveryLocale((locale) => (reason
          ? PREVIEW_TASK_COPY[locale].conflict[reason]
          : localizedApiError(error, locale, PREVIEW_TASK_COPY[locale].toggleFailed))), { tone: "danger" });
        if (reason) latest.current?.onConflict?.(reason);
      } finally {
        setPending((current) => {
          const next = new Map(current);
          next.delete(task.line);
          return next;
        });
      }
    });
  }, [noteId, toast]);

  return useMemo(() => (enabled ? { tasks: parsed, pending, toggle } : null), [enabled, parsed, pending, toggle]);
}

export function MarkdownPreview({ body, tasks, source, inEditor = false }: {
  body: string;
  tasks?: PreviewTasks;
  source?: { readonly line: number; readonly updatedAt: string };
  readonly inEditor?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const copy = useCopy(NOTES_COPY);
  const taskControls = useTaskControls(body, tasks);
  const preview = useRef<HTMLDivElement>(null);
  const line = source?.line;
  const updatedAt = source?.updatedAt;
  const lastScroll = useRef<{ line: number; updatedAt: string; body: string } | null>(null);
  const [located, setLocated] = useState<{ line: number; updatedAt: string; block: SourceBlock | null } | null>(null);
  useEffect(() => {
    if (line === undefined || updatedAt === undefined || !preview.current) return;
    const blocks = Array.from(preview.current.querySelectorAll<HTMLElement>("[data-source-start]"), (element) => ({
      element,
      startLine: Number(element.dataset.sourceStart),
      endLine: Number(element.dataset.sourceEnd),
    }));
    const block = sourceBlockForLine(blocks, line, body);
    setLocated({ line, updatedAt, block: block ? { startLine: block.startLine, endLine: block.endLine } : null });
    if (!block) return;
    const element = block.element;
    element.dataset.sourceTarget = "true";
    if (lastScroll.current?.line !== line || lastScroll.current.updatedAt !== updatedAt || lastScroll.current.body !== body) {
      element.scrollIntoView({ block: "center" });
      element.focus({ preventScroll: true });
      lastScroll.current = { line, updatedAt, body };
    }
    return () => { delete element.dataset.sourceTarget; };
  }, [body, line, updatedAt]);
  const location = located && located.line === line && located.updatedAt === updatedAt ? located : null;
  return (
    <div ref={preview} className={cn("prose-ko min-h-80 max-w-none overflow-x-auto bg-card text-ink [&_[data-source-start]]:scroll-mt-4 [&_[data-source-target]]:rounded-ctl [&_[data-source-target]]:bg-accent-soft [&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-desk [&_code]:px-1 [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:text-lg [&_img]:max-w-full [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-card [&_pre]:bg-desk [&_pre]:p-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:p-2 [&_th]:border [&_th]:border-line [&_th]:p-2 [&_ul]:list-disc", inEditor ? "px-1 py-4" : "rounded-card border border-line p-5")}>
      {source ? <p role="status" className="text-sm text-mute">{location
        ? location.block ? copy.detail.sourceLocated(source.line, location.block.startLine, location.block.endLine) : copy.detail.sourceNotRendered
        : copy.detail.sourceEvidence.checking}</p> : null}
      <TaskControlsContext.Provider value={taskControls}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, ...props }) => {
              const title = wikiTitleFromHref(href ?? "");
              if (title !== null) {
                return (
                  <a
                    href={href}
                    {...props}
                    onClick={(event) => {
                      event.preventDefault();
                      void api<{ note: NoteRef }>("/api/notes/by-title", { method: "POST", json: { title } })
                        .then(({ note }) => router.push(`/notes/${note.id}`))
                        .catch((error: unknown) => toast(textInEveryLocale((locale) => localizedApiError(error, locale, NOTES_COPY[locale].openLinkFailed)), { tone: "danger" }));
                    }}
                  >
                    {children}
                  </a>
                );
              }
              return <a href={href} rel="noreferrer noopener" target={href?.startsWith("http") ? "_blank" : undefined} {...props}>{children}</a>;
            },
            ...(source ? SOURCE_COMPONENTS : {}),
            ...(tasks ? TASK_COMPONENTS : {}),
            ...(source && tasks ? { li: SourceTaskListItem } : {}),
          }}
        >
          {expandWikiLinks(body)}
        </ReactMarkdown>
      </TaskControlsContext.Provider>
    </div>
  );
}
