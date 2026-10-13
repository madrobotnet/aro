import { ChangeSet, EditorSelection, StateEffect, StateField, type ChangeDesc } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isComposing } from "./wikilink-autocomplete";

export type DeferredEdit =
  | { readonly kind: "change"; readonly changes: ChangeSet }
  | { readonly kind: "command"; readonly selection: EditorSelection; readonly run: (view: EditorView, selection: EditorSelection) => void };

export const compositionSettled = StateEffect.define<null>();
const composing = StateEffect.define<boolean>();
export const compositionActive = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((active, effect) => effect.is(composing) ? effect.value : active, value),
});
const enqueue = StateEffect.define<DeferredEdit>();
const takeFirst = StateEffect.define<null>();

/** Positions and structural changes follow preedit replacements without touching composing DOM. */
export function mapDeferred(edit: DeferredEdit, changes: ChangeDesc): DeferredEdit {
  switch (edit.kind) {
    case "change": return { ...edit, changes: edit.changes.map(changes) };
    case "command": return { ...edit, selection: edit.selection.map(changes) };
  }
}

export const deferredEdits = StateField.define<readonly DeferredEdit[]>({
  create: () => [],
  update(value, tr) {
    let pending = tr.docChanged ? value.map((edit) => mapDeferred(edit, tr.changes)) : value;
    for (const effect of tr.effects) {
      if (effect.is(enqueue)) pending = [...pending, effect.value];
      if (effect.is(takeFirst)) pending = pending.slice(1);
    }
    return pending;
  },
});

export function deferEdit(view: EditorView, edit: DeferredEdit): void {
  if (isComposing(view)) { view.dispatch({ effects: enqueue.of(edit) }); return; }
  apply(view, edit);
}

function apply(view: EditorView, edit: DeferredEdit): void {
  switch (edit.kind) {
    case "change": view.dispatch({ changes: edit.changes, userEvent: "input.external" }); break;
    case "command": edit.run(view, edit.selection); break;
  }
}

/** Minimal external source delta, rather than a whole-document replacement during preedit. */
export function sourceChange(before: string, after: string): ChangeSet {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return ChangeSet.of({ from, to: oldEnd, insert: after.slice(from, newEnd) }, before.length);
}

export const compositionEdits = [
  compositionActive,
  deferredEdits,
  EditorView.domEventHandlers({
    compositionstart(_event, view) { view.dispatch({ effects: composing.of(true) }); },
    compositionend(_event, view) {
      // CM's observer flushes the native commit first. A new composition in the
      // same frame retains the queue for its own end event.
      requestAnimationFrame(() => {
        if (isComposing(view)) return;
        view.dispatch({ effects: composing.of(false) });
        while (view.state.field(deferredEdits).length) {
          const next = view.state.field(deferredEdits)[0];
          if (!next) break;
          view.dispatch({ effects: takeFirst.of(null) });
          apply(view, next);
        }
        view.dispatch({ effects: compositionSettled.of(null) });
      });
    },
  }),
];
