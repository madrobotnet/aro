import { syntaxTree } from "@codemirror/language";
import { EditorSelection, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { compositionActive, compositionSettled, deferEdit } from "./composition-edits";
import { liveLabels, liveRaw, liveWindows, type LiveWindow } from "./live-markdown";
import { isComposing } from "./wikilink-autocomplete";

type Cell = { readonly from: number; readonly text: string };
export type LiveTable = { readonly from: number; readonly to: number; readonly rows: readonly { readonly header: boolean; readonly cells: readonly Cell[] }[] };

/** Only visit visible syntax subtrees, including a table that crosses a window edge. */
export function liveTableRanges(state: EditorState, windows: readonly LiveWindow[]): LiveTable[] {
  if (state.facet(liveRaw)) return [];
  const tables = new Map<number, LiveTable>();
  for (const window of windows) syntaxTree(state).iterate({
    from: window.from, to: window.to,
    enter(node) {
      if (node.name === "FencedCode" || node.name === "CodeBlock") return false;
      if (node.name !== "Table") return;
      if (!state.selection.ranges.some((selection) => selection.from <= node.to && selection.to >= node.from)) {
        const rows = node.node.getChildren("TableHeader").concat(node.node.getChildren("TableRow")).map((row) => ({
          header: row.name === "TableHeader",
          cells: row.getChildren("TableCell").map((cell) => ({ from: cell.from, text: state.sliceDoc(cell.from, cell.to) })),
        }));
        tables.set(node.from, { from: node.from, to: node.to, rows });
      }
      return false;
    },
  });
  return [...tables.values()];
}

class TableWidget extends WidgetType {
  constructor(readonly table: LiveTable, readonly editSource: (text: string) => string) { super(); }
  eq(other: TableWidget) { return this.editSource === other.editSource && JSON.stringify(this.table) === JSON.stringify(other.table); }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-live-table";
    const table = document.createElement("table");
    wrap.append(table);
    for (const row of this.table.rows) {
      const tr = document.createElement("tr");
      table.append(tr);
      for (const cell of row.cells) {
        const td = document.createElement(row.header ? "th" : "td");
        td.textContent = cell.text.replace(/\\([|\\])/g, "$1");
        if (row.header) td.setAttribute("scope", "col");
        td.tabIndex = 0;
        td.setAttribute("aria-label", this.editSource(cell.text));
        const enter = () => deferEdit(view, { kind: "command", selection: EditorSelection.single(view.posAtDOM(wrap) + cell.from - this.table.from), run(current, selection) {
          current.dispatch({ selection, scrollIntoView: true });
          current.focus();
        } });
        td.addEventListener("mousedown", (event) => { event.preventDefault(); enter(); });
        td.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); enter(); } });
        tr.append(td);
      }
    }
    return wrap;
  }
  ignoreEvent() { return true; }
}

function tableDecorations(state: EditorState, windows: readonly LiveWindow[]): DecorationSet {
  return Decoration.set(liveTableRanges(state, windows).map((table) => Decoration.replace({
    block: true, inclusive: true, widget: new TableWidget(table, state.facet(liveLabels).editSource),
  }).range(table.from, table.to)), true);
}

const tableWindows = StateEffect.define<readonly LiveWindow[]>();
const tableField = StateField.define<{ readonly windows: readonly LiveWindow[]; readonly decorations: DecorationSet }>({
  create(state) {
    const windows = [{ from: 0, to: state.doc.line(Math.min(40, state.doc.lines)).to }];
    return { windows, decorations: tableDecorations(state, windows) };
  },
  update(value, tr) {
    let windows = tr.docChanged ? value.windows.map((window) => ({ from: tr.changes.mapPos(window.from), to: tr.changes.mapPos(window.to, 1) })) : value.windows;
    for (const effect of tr.effects) if (effect.is(tableWindows)) windows = effect.value;
    if (tr.state.field(compositionActive, false)) return { windows, decorations: value.decorations.map(tr.changes) };
    if (tr.docChanged || tr.selection || windows !== value.windows || syntaxTree(tr.startState) !== syntaxTree(tr.state) || tr.state.facet(liveRaw) !== tr.startState.facet(liveRaw) || tr.state.facet(liveLabels) !== tr.startState.facet(liveLabels) || tr.effects.some((effect) => effect.is(compositionSettled))) {
      return { windows, decorations: tableDecorations(tr.state, windows) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export class LiveTableViewport {
  private pending = false;
  private destroyed = false;
  constructor(view: EditorView) { this.measure(view); }
  update(update: ViewUpdate) {
    if (update.viewportChanged || update.docChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(compositionSettled)))) this.measure(update.view);
  }
  measure(view: EditorView) {
    view.requestMeasure({
      key: this,
      read(current) { return liveWindows(current.state, current.visibleRanges); },
      write: (_windows, current) => {
        if (this.pending || this.destroyed) return;
        this.pending = true;
        // requestMeasure.write still holds EditorView's update lock. A microtask
        // runs after that complete measurement, coalescing writes without keeping
        // a stale window or transaction across document/viewport changes.
        queueMicrotask(() => {
          this.pending = false;
          if (this.destroyed || isComposing(current) || current.state.field(compositionActive, false)) return;
          const windows = liveWindows(current.state, current.visibleRanges);
          if (JSON.stringify(windows) !== JSON.stringify(current.state.field(tableField).windows)) current.dispatch({ effects: tableWindows.of(windows) });
        });
      },
    });
  }
  destroy() { this.destroyed = true; }
}
const viewport = ViewPlugin.fromClass(LiveTableViewport);

const tableTheme = EditorView.baseTheme({
  ".cm-live-table": { maxWidth: "100%", overflowX: "auto", padding: "0.5rem 0" },
  ".cm-live-table table": { borderCollapse: "collapse", maxWidth: "100%", fontFamily: "var(--font-sans)", fontSize: "var(--text-base)" },
  ".cm-live-table th, .cm-live-table td": { border: "1px solid var(--line)", padding: "0.5rem 0.75rem", textAlign: "left", overflowWrap: "anywhere", maxWidth: "16rem", cursor: "text" },
  ".cm-live-table th": { backgroundColor: "var(--desk)", fontWeight: "600" },
});

export function liveTables() { return [tableField, viewport, tableTheme]; }
