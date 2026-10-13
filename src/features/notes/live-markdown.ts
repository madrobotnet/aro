import { syntaxTree } from "@codemirror/language";
import { StateEffect, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { parseInlineTags } from "@/lib/wikilinks";

type Window = { readonly from: number; readonly to: number };
export type LiveRange =
  | { readonly kind: "hide"; readonly from: number; readonly to: number; readonly syntax: string }
  | { readonly kind: "mark"; readonly from: number; readonly to: number; readonly className: string }
  | { readonly kind: "line"; readonly from: number; readonly className: string }
  | { readonly kind: "bullet"; readonly from: number; readonly to: number };

const refreshLive = StateEffect.define<null>();

/** Line-aligned visible windows plus four lines; never stringify the whole document. */
export function liveWindows(state: EditorState, visible: readonly Window[]): Window[] {
  const windows: Window[] = [];
  for (const range of visible) {
    const from = state.doc.line(Math.max(1, state.doc.lineAt(range.from).number - 4)).from;
    const to = state.doc.line(Math.min(state.doc.lines, state.doc.lineAt(range.to).number + 4)).to;
    const previous = windows[windows.length - 1];
    if (previous && from <= previous.to) windows[windows.length - 1] = { from: previous.from, to: Math.max(to, previous.to) };
    else windows.push({ from, to });
  }
  return windows;
}

function activeLine(state: EditorState, from: number): boolean {
  const line = state.doc.lineAt(from).number;
  return state.selection.ranges.some((range) => line >= state.doc.lineAt(range.from).number && line <= state.doc.lineAt(range.to).number);
}

/** Plans are also the unit-test surface: replacements with no widget contain syntax only. */
export function liveRanges(state: EditorState, windows: readonly Window[]): LiveRange[] {
  const ranges: LiveRange[] = [];
  const tree = syntaxTree(state);
  const seen = new Set<string>();
  const add = (range: LiveRange) => {
    const key = JSON.stringify(range);
    if (!seen.has(key)) { seen.add(key); ranges.push(range); }
  };
  for (const window of windows) {
    tree.iterate({
      from: window.from, to: window.to,
      enter(node) {
        if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "Table") return false;
        const line = state.doc.lineAt(node.from);
        if (/^ATXHeading[1-6]$/.test(node.name)) add({ kind: "line", from: line.from, className: `cm-live-h${node.name.slice(-1)}` });
        if (node.name === "QuoteMark") add({ kind: "line", from: line.from, className: "cm-live-quote" });
        const className = node.name === "StrongEmphasis" ? "cm-live-strong" : node.name === "Emphasis" ? "cm-live-em" : node.name === "InlineCode" ? "cm-live-code" : null;
        if (className) add({ kind: "mark", from: node.from, to: node.to, className });
        if (!activeLine(state, node.from)) {
          if (["HeaderMark", "EmphasisMark", "CodeMark", "QuoteMark"].includes(node.name)) {
            add({ kind: "hide", from: node.from, to: node.to, syntax: node.name });
          }
          if (node.name === "ListMark" && /^[-*+]$/.test(state.sliceDoc(node.from, node.to))) {
            add({ kind: "bullet", from: node.from, to: node.to });
          }
        }
      },
    });
    const first = state.doc.lineAt(window.from).number;
    const last = state.doc.lineAt(window.to).number;
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number);
      for (const match of line.text.matchAll(/(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu)) {
        if (!parseInlineTags(match[0]).length) continue;
        const from = line.from + match.index + (match[1] ?? "").length;
        let node: ReturnType<typeof tree.resolve> | null = tree.resolve(from, 1);
        let excluded = false;
        while (node) {
          if (["InlineCode", "FencedCode", "CodeBlock", "Table", "Link"].includes(node.name)) { excluded = true; break; }
          node = node.parent;
        }
        if (!excluded) add({ kind: "mark", from, to: from + (match[2] ?? "").length + 1, className: "cm-live-tag" });
      }
    }
  }
  return ranges;
}

class BulletWidget extends WidgetType {
  toDOM() {
    const node = document.createElement("span");
    node.textContent = "•";
    node.className = "cm-live-bullet";
    node.setAttribute("aria-hidden", "true");
    return node;
  }
}

export function liveDecorations(state: EditorState, windows: readonly Window[]): DecorationSet {
  const ranges: Range<Decoration>[] = liveRanges(state, windows).map((range) => {
    switch (range.kind) {
      case "hide": return Decoration.replace({}).range(range.from, range.to);
      case "bullet": return Decoration.replace({ widget: new BulletWidget() }).range(range.from, range.to);
      case "line": return Decoration.line({ class: range.className }).range(range.from);
      case "mark": return Decoration.mark({ class: range.className }).range(range.from, range.to);
    }
  });
  return Decoration.set(ranges, true);
}

const livePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = liveDecorations(view.state, liveWindows(view.state, view.visibleRanges)); }
  update(update: ViewUpdate) {
    // Mapping preserves the composing DOM. The incremental Lezer tree is reused
    // on ordinary edits; only the visible windows are visited to build decorations.
    if (update.view.composing) { this.decorations = this.decorations.map(update.changes); return; }
    if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state) || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshLive)))) {
      this.decorations = liveDecorations(update.state, liveWindows(update.state, update.view.visibleRanges));
    }
  }
}, { decorations: (plugin) => plugin.decorations });

const liveTheme = EditorView.baseTheme({
  ".cm-live-h1": { fontSize: "var(--text-2xl)", fontWeight: "700" },
  ".cm-live-h2": { fontSize: "var(--text-xl)", fontWeight: "700" },
  ".cm-live-h3, .cm-live-h4, .cm-live-h5, .cm-live-h6": { fontSize: "var(--text-lg)", fontWeight: "600" },
  ".cm-live-strong": { fontWeight: "700" },
  ".cm-live-em": { fontStyle: "italic" },
  ".cm-live-code": { fontFamily: "var(--font-mono)", backgroundColor: "var(--desk)", borderRadius: "var(--radius-ctl)" },
  ".cm-live-tag": { color: "var(--accent)", backgroundColor: "var(--accent-soft)", borderRadius: "var(--radius-pill)" },
  ".cm-live-quote": { borderLeft: "2px solid var(--line-strong)", paddingLeft: "1rem", color: "var(--mute)" },
  ".cm-live-bullet": { color: "var(--mute)" },
});

export function liveMarkdown() {
  return [
    livePlugin, liveTheme,
    EditorView.domEventHandlers({
      compositionend(_event, view) {
        requestAnimationFrame(() => { if (!view.composing) view.dispatch({ effects: refreshLive.of(null) }); });
      },
    }),
  ];
}
