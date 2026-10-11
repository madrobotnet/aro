import type { QueryResultRow } from "pg";
import {
  parseTasks, toggleTask, type TaskEntry, type TaskItem, type TaskList, type TaskState, type TaskToggle,
} from "@/lib/tasks";
import { db, tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { notesCopy } from "@/server/i18n/copy";
import { assertNoteId, getNote, updateNote, type NoteDetail } from "@/server/notes/service";
import { tasksCopy } from "./copy";

export type ToggleNoteTaskInput = TaskToggle & { readonly noteId: string };

/** Most recently updated notes scanned per request, and tasks returned. */
export const TASK_NOTE_LIMIT = 500;
export const TASK_RESULT_LIMIT = 2000;

// Cheap SQL prefilter for `[ ]`/`[\t]` and `[x]`/`[X]`; parseTasks decides what is a real task.
const PREFILTER: Record<TaskState, string> = {
  open: "\\[[[:blank:]]\\]",
  done: "\\[[xX]\\]",
  all: "\\[[[:blank:]xX]\\]",
};

type TaskNoteRow = QueryResultRow & {
  id: string; title: string; body: string; daily_date: string | null; updated_at: Date;
};
type LockedNoteRow = QueryResultRow & { body: string; status: string; deleted_at: Date | null };

const matches = (state: TaskState, task: TaskItem): boolean => {
  switch (state) {
    case "open": return !task.done;
    case "done": return task.done;
    case "all": return true;
    default: { const unreachable: never = state; return unreachable; }
  }
};

/** Tasks from active notes (not trashed, not archived), newest note first, in line order. */
export async function listTasks(state: TaskState): Promise<TaskList> {
  if (databaseBackend() === "sqlite") {
    const store = await sqliteStore();
    const predicate = state === "open" ? "(instr(body,'[ ]')>0 OR instr(body,char(91)||char(9)||char(93))>0)"
      : state === "done" ? "(instr(body,'[x]')>0 OR instr(body,'[X]')>0)"
        : "(instr(body,'[ ]')>0 OR instr(body,char(91)||char(9)||char(93))>0 OR instr(body,'[x]')>0 OR instr(body,'[X]')>0)";
    const rows = store.all<{ id: string; title: string; body: string; daily_date: string | null; updated_at: string }>(
      `SELECT id,title,body,daily_date,updated_at FROM notes WHERE deleted_at IS NULL AND status<>'archived' AND ${predicate} ORDER BY updated_at DESC,id DESC LIMIT ?`,
      [TASK_NOTE_LIMIT + 1],
    );
    const tasks: TaskEntry[] = [];
    for (const row of rows.slice(0, TASK_NOTE_LIMIT)) {
      for (const task of parseTasks(row.body)) {
        if (!matches(state, task)) continue;
        if (tasks.length === TASK_RESULT_LIMIT) return { tasks, truncated: true };
        tasks.push({ ...task, noteId: row.id, title: row.title, dailyDate: row.daily_date,
          noteUpdatedAt: new Date(row.updated_at).toISOString() });
      }
    }
    return { tasks, truncated: rows.length > TASK_NOTE_LIMIT };
  }
  const pool = await db();
  const result = await pool.query<TaskNoteRow>(
    `SELECT id,title,body,to_char(daily_date,'YYYY-MM-DD') AS daily_date,updated_at FROM notes
      WHERE deleted_at IS NULL AND status<>'archived' AND body ~ $1
      ORDER BY updated_at DESC,id DESC LIMIT $2`,
    [PREFILTER[state], TASK_NOTE_LIMIT + 1],
  );
  const tasks: TaskEntry[] = [];
  for (const row of result.rows.slice(0, TASK_NOTE_LIMIT)) {
    for (const task of parseTasks(row.body)) {
      if (!matches(state, task)) continue;
      if (tasks.length === TASK_RESULT_LIMIT) return { tasks, truncated: true };
      tasks.push({
        ...task, noteId: row.id, title: row.title, dailyDate: row.daily_date, noteUpdatedAt: row.updated_at.toISOString(),
      });
    }
  }
  return { tasks, truncated: result.rows.length > TASK_NOTE_LIMIT };
}

/** Check or uncheck one task line after verifying it still reads `expectedText`. */
export async function toggleNoteTask(input: ToggleNoteTaskInput): Promise<{ note: NoteDetail; task: TaskItem }> {
  assertNoteId(input.noteId);
  const task: TaskItem = { line: input.line, text: input.expectedText, done: input.done };
  if (databaseBackend() === "sqlite") {
    const store = await sqliteStore();
    const { getSQLiteNote, updateSQLiteNote } = await import("@/server/notes/sqlite");
    const note = store.transaction(q => {
      const row = getSQLiteNote(q, input.noteId);
      if (!row) throw new ApiError("not_found", notesCopy.notFound);
      if (row.deletedAt) throw new ApiError("conflict", notesCopy.trashedReadOnly, { reason: "trashed" });
      if (row.archived) throw new ApiError("conflict", tasksCopy.archived, { reason: "archived" });
      const result = toggleTask(row.body, input);
      if (!result.ok) throw new ApiError("conflict", tasksCopy.mismatch, { reason: "mismatch" });
      return result.changed ? updateSQLiteNote(q, row.id, { body: result.body }, "task-toggle") : row;
    });
    return { note, task };
  }
  const note = await tx(async (client) => {
    const locked = await client.query<LockedNoteRow>(
      "SELECT body,status,deleted_at FROM notes WHERE id=$1 FOR UPDATE", [input.noteId],
    );
    const row = locked.rows[0];
    if (!row) throw new ApiError("not_found", notesCopy.notFound);
    if (row.deleted_at) throw new ApiError("conflict", notesCopy.trashedReadOnly, { reason: "trashed" });
    if (row.status === "archived") throw new ApiError("conflict", tasksCopy.archived, { reason: "archived" });
    const result = toggleTask(row.body, input);
    if (!result.ok) throw new ApiError("conflict", tasksCopy.mismatch, { reason: "mismatch" });
    return result.changed ? updateNote(input.noteId, { body: result.body }, { reason: "task-toggle", client }) : null;
  });
  if (note) return { note, task };
  const current = await getNote(input.noteId);
  if (!current) throw new ApiError("not_found", notesCopy.notFound);
  return { note: current, task };
}
