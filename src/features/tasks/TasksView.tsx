"use client";

import { CalendarDays, FileText, ListChecks, RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { Badge, Button, EmptyState, SkeletonLines, useToast } from "@/components/ui";
import { refreshNoteViews } from "@/features/notes/note-cache";
import { applySavedTaskToggle } from "@/features/notes/draft-store";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import type { TaskEntry, TaskItem, TaskList, TaskState } from "@/lib/tasks";
import type { Note } from "@/lib/types";
import {
  dailyLabel, fitsTaskFilter, groupTasksByNote, isStaleTaskError, neighbourTaskKey, parseTaskState, TASK_STATES, taskDisplayText, taskKey,
  tasksApiUrl, tasksPageHref, withTaskToggled, type TaskGroup,
} from "./task-model";
import { TASKS_COPY } from "./tasks-copy";

const PAGE = "mx-auto w-full max-w-6xl px-4 pb-12 pt-5 sm:px-6 lg:px-10 lg:pt-10";

/** Focus a task's checkbox, or the active filter when no task is left to take it. */
function focusTask(key: string | null) {
  const checkbox = key === null ? null : document.querySelector<HTMLElement>(`[data-task-key="${CSS.escape(key)}"]`);
  (checkbox ?? document.querySelector<HTMLElement>('[data-task-filter][aria-pressed="true"]'))?.focus();
}

/** Suspense fallback for the tasks route; a client component so it follows a language switch. */
export function TasksLoading() {
  const copy = useCopy(TASKS_COPY);
  return (
    <div aria-busy="true" className={PAGE}>
      <span role="status" className="sr-only">{copy.loading}</span>
      <div className="border-b border-line pb-5">
        <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">{copy.title}</h1>
        <p className="mt-1 text-sm text-mute">{copy.lead}</p>
      </div>
      <div className="surface-card mt-6 p-4"><SkeletonLines lines={5} /></div>
    </div>
  );
}

export function TasksView() {
  const router = useRouter();
  const params = useSearchParams();
  const { locale } = useLocale();
  const copy = useCopy(TASKS_COPY);
  const { toast } = useToast();
  const { cache, mutate } = useSWRConfig();
  const state = parseTaskState(params.get("state"));
  const list = useSWR<TaskList>(tasksApiUrl(state));
  const groups = useMemo(() => groupTasksByNote(list.data?.tasks ?? []), [list.data]);
  // Requested state of each in-flight toggle; removing the entry rolls the checkbox back to the list value.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // A focused task that leaves the filter would drop focus to the page; its neighbour takes it once the list re-renders.
  const focusAfter = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (focusAfter.current === undefined) return;
    focusTask(focusAfter.current);
    focusAfter.current = undefined;
  }, [list.data]);

  const toggle = async (task: TaskEntry, done: boolean) => {
    const key = taskKey(task);
    if (pending.has(key)) return;
    setPending((current) => new Map(current).set(key, done));
    try {
      const result = await api<{ note: Note; task: TaskItem }>("/api/tasks/toggle", {
        method: "POST",
        json: { noteId: task.noteId, line: task.line, expectedText: task.text, done },
      });
      void applySavedTaskToggle(result.note, { line: task.line, expectedText: task.text, done });
      if (!fitsTaskFilter(done, state) && document.activeElement?.getAttribute("data-task-key") === key) {
        focusAfter.current = neighbourTaskKey(groups.flatMap((group) => group.tasks), task);
      }
      await list.mutate((current) => (current ? withTaskToggled(current, task, done, state) : current), { revalidate: false });
      void mutate(`/api/notes/${task.noteId}`, { note: result.note }, { revalidate: false });
      void refreshNoteViews({ cache, mutate });
    } catch (error) {
      toast(textInEveryLocale((each) => localizedApiError(error, each, TASKS_COPY[each].toggleFailed)), { tone: "danger" });
      if (isStaleTaskError(error)) void list.mutate();
    } finally {
      setPending((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }
  };

  const setState = (next: TaskState) => router.replace(tasksPageHref(next), { scroll: false });
  const taskCount = list.data?.tasks.length ?? 0;

  return (
    <div className={PAGE}>
      <DocumentTitle title={copy.title} />
      <header className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">{copy.title}</h1>
          <p className="mt-1 max-w-prose text-sm text-mute">{copy.lead}</p>
        </div>
        <div role="group" className="flex shrink-0 rounded-ctl bg-line/50 p-1 sm:w-72" aria-label={copy.filterLabel}>
          {TASK_STATES.map((value) => (
            <button key={value} type="button" data-task-filter aria-pressed={state === value} onClick={() => setState(value)} className={`flex-1 rounded-ctl px-3 py-1.5 text-sm max-lg:min-h-touch ${state === value ? "bg-card font-medium text-ink shadow-card" : "text-mute hover:text-ink"}`}>{copy.filters[value]}</button>
          ))}
        </div>
      </header>

      {list.error && !list.data ? (
        <div role="alert" className="mt-6 rounded-card border border-danger/30 bg-danger-soft p-5">
          <p className="font-medium text-danger">{copy.loadFailed}</p>
          <p className="mt-1 text-sm text-mute">{localizedApiError(list.error, locale, copy.loadHint)}</p>
          <Button className="mt-3" size="lg" leading={<RefreshCw aria-hidden className="size-4" />} onClick={() => void list.mutate()}>
            {copy.retry}
          </Button>
        </div>
      ) : null}

      {list.isLoading && !list.data ? (
        <div aria-busy="true" className="surface-card mt-6 p-4">
          <span role="status" className="sr-only">{copy.loading}</span>
          <SkeletonLines lines={5} />
        </div>
      ) : null}

      {list.data && taskCount === 0 ? (
        <EmptyState className="mt-6" icon={ListChecks} title={copy.empty[state]} description={copy.emptyHint[state]} />
      ) : null}

      {list.data && taskCount > 0 ? (
        <>
          <p className="mt-6 text-sm text-mute" aria-live="polite">{copy.summary(taskCount, groups.length)}</p>
          {list.data.truncated ? (
            <p role="status" className="mt-3 flex items-start gap-2 rounded-card border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-ink">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
              {copy.truncated}
            </p>
          ) : null}
          <ul aria-label={copy.listLabel} className="mt-3 flex flex-col gap-4">
            {groups.map((group) => (
              <li key={group.noteId}>
                <TaskGroupCard group={group} pending={pending} onToggle={(task, done) => void toggle(task, done)} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function TaskGroupCard({ group, pending, onToggle }: {
  group: TaskGroup;
  pending: ReadonlyMap<string, boolean>;
  onToggle: (task: TaskEntry, done: boolean) => void;
}) {
  const { locale } = useLocale();
  const copy = useCopy(TASKS_COPY);
  const headingId = useId();
  const Icon = group.dailyDate ? CalendarDays : FileText;
  const open = group.tasks.filter((task) => !(pending.get(taskKey(task)) ?? task.done)).length;
  return (
    <section aria-labelledby={headingId} className="surface-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5">
        <Icon aria-hidden className="size-4 shrink-0 text-mute" />
        <h2 id={headingId} className="min-w-0 flex-1 text-md font-semibold">
          <Link href={`/notes/${encodeURIComponent(group.noteId)}`} className="inline-flex min-h-touch items-center rounded-ctl underline-offset-4 hover:underline focus-ring">
            {group.dailyDate ? dailyLabel(group.dailyDate, locale) : group.title}
          </Link>
        </h2>
        {group.dailyDate ? <Badge>{copy.daily}</Badge> : null}
        <span className="text-xs text-mute tabular-nums">{copy.groupCount(open, group.tasks.length)}</span>
      </div>
      <ul className="divide-y divide-line">
        {group.tasks.map((task) => {
          const key = taskKey(task);
          const busy = pending.has(key);
          const checked = pending.get(key) ?? task.done;
          return (
            <li key={key} aria-busy={busy || undefined}>
              <label className="flex min-h-touch cursor-pointer items-start gap-3 px-4 py-2.5 transition-colors hover:bg-desk">
                <input
                  type="checkbox"
                  data-task-key={key}
                  checked={checked}
                  onChange={(event) => {
                    if (!busy) onToggle(task, event.target.checked);
                  }}
                  className="mt-1 size-4 shrink-0 cursor-pointer accent-accent"
                />
                <span className={`min-w-0 flex-1 text-md ${checked ? "text-mute line-through" : "text-ink"}`}>{taskDisplayText(task.text)}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
