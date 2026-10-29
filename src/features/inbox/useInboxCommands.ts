import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { CHORD_TIMEOUT_MS, IDLE_CHORD, isEditableTarget, resolveShortcut, type ChordState } from "@/components/shell/shortcuts";
import type { InboxItem } from "@/lib/types";
import { moveSelection, resolveTriageKey, type InboxView } from "./inbox-triage";

export function useInboxCommands({ busy, discard, items, openSnooze, selected, view, setSelectedId, setDetailOpen, titleRef }: {
  readonly busy: boolean;
  readonly discard: (item: InboxItem) => Promise<void>;
  readonly items: readonly InboxItem[];
  readonly openSnooze: (item: InboxItem) => void;
  readonly selected: InboxItem | null;
  readonly view: InboxView;
  readonly setSelectedId: Dispatch<SetStateAction<string | null | undefined>>;
  readonly setDetailOpen: Dispatch<SetStateAction<boolean>>;
  readonly titleRef: RefObject<HTMLInputElement | null>;
}) {
  const chord = useRef<ChordState>(IDLE_CHORD);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
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
  }, [busy, discard, items, openSnooze, selected, view, setSelectedId, setDetailOpen, titleRef]);

}
