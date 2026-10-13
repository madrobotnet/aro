import type { Note } from "@/lib/types";
import { mergeTaskToggle, NoteDraftController, type EditableNote } from "./note-draft";
import type { TaskToggle } from "@/lib/tasks";

// Client-session drafts outlive route components so a failed save is recoverable.
const drafts = new Map<string, NoteDraftController>();

export function getNoteDraft(note: Note, save: (id: string, value: EditableNote) => Promise<Note>): NoteDraftController {
  const existing = drafts.get(note.id);
  if (existing) return existing;
  const controller = new NoteDraftController(note, save);
  drafts.set(note.id, controller);
  return controller;
}

export function forgetNoteDraft(id: string): void {
  drafts.delete(id);
}

/** The tasks page must merge its mark into a retained dirty draft, not overwrite it on revalidation. */
export function applySavedTaskToggle(note: Note, toggle: TaskToggle): Promise<boolean> {
  const controller = drafts.get(note.id);
  if (!controller) return Promise.resolve(true);
  const snapshot = controller.getSnapshot();
  const merge = mergeTaskToggle(snapshot, toggle, snapshot.state === "saved");
  switch (merge.kind) {
    case "replace": controller.replace(note); return Promise.resolve(true);
    case "keep": return Promise.resolve(true);
    case "update": controller.update({ body: merge.body }); return controller.flush();
  }
}

export function hasUnsavedNoteDrafts(): boolean {
  return [...drafts.values()].some((draft) => draft.getSnapshot().state !== "saved");
}
