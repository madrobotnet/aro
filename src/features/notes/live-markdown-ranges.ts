import { syntaxTree } from "@codemirror/language";
import { Facet, type EditorState } from "@codemirror/state";
import { parseInlineTags, parseWikiLinks } from "@/lib/wikilinks";
import { parseTasks } from "@/lib/tasks";
import { defaultUrlTransform } from "react-markdown";
import { LIVE_EDITOR_COPY } from "./live-editor-copy";

export type LiveWindow = { readonly from: number; readonly to: number };
export const liveRaw = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });
export type LiveRange =
  | { readonly kind: "hide"; readonly from: number; readonly to: number; readonly syntax: string }
  | { readonly kind: "mark"; readonly from: number; readonly to: number; readonly className: string }
  | { readonly kind: "line"; readonly from: number; readonly className: string }
  | { readonly kind: "bullet"; readonly from: number; readonly to: number }
  | { readonly kind: "task"; readonly from: number; readonly to: number; readonly done: boolean; readonly label: string }
  | { readonly kind: "link"; readonly from: number; readonly to: number; readonly label: string; readonly url: string }
  | { readonly kind: "wiki"; readonly from: number; readonly to: number; readonly label: string; readonly target: string };

type LiveLabels = {
  readonly editSource: (text: string) => string;
  readonly wikiLabel: (label: string, target: string) => string;
  readonly linkActions: string;
  readonly openLink: string;
  readonly editLink: string;
};
export const liveLabels = Facet.define<LiveLabels, LiveLabels>({
  combine: (values) => values[0] ?? LIVE_EDITOR_COPY.en,
});

/** Line-aligned visible windows plus four lines; never stringify the whole document. */
export function liveWindows(state: EditorState, visible: readonly LiveWindow[]): LiveWindow[] {
  const windows: LiveWindow[] = [];
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
export function liveRanges(state: EditorState, windows: readonly LiveWindow[]): LiveRange[] {
  if (state.facet(liveRaw)) return [];
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
        if (node.name === "FencedCode" || node.name === "CodeBlock") {
          const first = Math.max(state.doc.lineAt(node.from).number, state.doc.lineAt(window.from).number);
          const last = Math.min(state.doc.lineAt(node.to).number, state.doc.lineAt(window.to).number);
          for (let number = first; number <= last; number++) add({ kind: "line", from: state.doc.line(number).from, className: "cm-live-fence" });
          for (const marker of node.node.getChildren("CodeMark")) {
            if (marker.from >= window.from && marker.from <= window.to && !activeLine(state, marker.from)) add({ kind: "hide", from: marker.from, to: marker.to, syntax: "FenceMark" });
          }
          const info = node.node.getChild("CodeInfo");
          if (info && !activeLine(state, info.from)) add({ kind: "mark", from: info.from, to: info.to, className: "cm-live-code-info" });
          return false;
        }
        if (node.name === "Table") return false;
        const line = state.doc.lineAt(node.from);
        if (node.name === "Link" && !state.selection.ranges.some((range) => state.doc.lineAt(range.from).number <= state.doc.lineAt(node.to).number && state.doc.lineAt(range.to).number >= line.number)) {
          const url = node.node.getChild("URL");
          const [open, close, destination] = node.node.getChildren("LinkMark");
          // Reference-like brackets and images are not inline link syntax.
          if (open && close && destination && state.sliceDoc(destination.from, destination.to) === "(") {
            const target = url ? state.sliceDoc(url.from, url.to).replace(/^<|>$/g, "").replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1") : "";
            const from = Math.max(open.to, window.from), to = Math.min(close.from, window.to);
            if (from < to) add({ kind: "link", from, to, label: state.sliceDoc(open.to, close.from), url: defaultUrlTransform(target) });
            for (const syntax of [{ from: node.from, to: open.to }, { from: close.from, to: node.to }]) {
              for (let number = state.doc.lineAt(Math.max(syntax.from, window.from)).number; number <= state.doc.lineAt(Math.min(syntax.to, window.to)).number; number++) {
                const part = state.doc.line(number);
                const from = Math.max(part.from, syntax.from, window.from), to = Math.min(part.to, syntax.to, window.to);
                if (from < to) add({ kind: "hide", from, to, syntax: "LinkSyntax" });
              }
            }
          }
        }
        if (node.name === "ListItem") {
          const marker = node.node.getChild("ListMark");
          const taskMarker = node.node.getChild("Task")?.getChild("TaskMarker");
          let parent = node.node.parent;
          let quoted = false;
          while (parent) { if (parent.name === "Blockquote") quoted = true; parent = parent.parent; }
          // Lezer supplies container/code context. The shared scanner supplies
          // the exact task recognition/text contract, on this bounded item line.
          const task = marker && taskMarker && !quoted ? parseTasks(state.sliceDoc(marker.from, line.to))[0] : undefined;
          if (marker && taskMarker && task) {
            const textStart = taskMarker.to + (/^[ \t]+/.exec(state.sliceDoc(taskMarker.to, line.to))?.[0].length ?? 0);
            if (task.done) add({ kind: "mark", from: textStart, to: line.to, className: "cm-live-done" });
            if (!activeLine(state, node.from)) {
              const ordered = /^\d+[.)]$/.test(state.sliceDoc(marker.from, marker.to));
              add({ kind: "task", from: ordered ? taskMarker.from : marker.from, to: ordered ? taskMarker.to : textStart, done: task.done, label: task.text });
            }
          }
        }
        if (/^ATXHeading[1-6]$/.test(node.name)) add({ kind: "line", from: line.from, className: `cm-live-h${node.name.slice(-1)}` });
        if (/^SetextHeading[12]$/.test(node.name)) {
          const underline = node.node.getChild("HeaderMark");
          if (underline) {
            const last = state.doc.lineAt(underline.from).number;
            for (let number = Math.max(line.number, state.doc.lineAt(window.from).number); number < last && number <= state.doc.lineAt(window.to).number; number++) {
              add({ kind: "line", from: state.doc.line(number).from, className: `cm-live-h${node.name.slice(-1)}` });
            }
          }
        }
        if (node.name === "QuoteMark") add({ kind: "line", from: line.from, className: "cm-live-quote" });
        const emphasisClass = node.name === "Emphasis" && /\p{Script=Hangul}/u.test(state.sliceDoc(Math.max(node.from, window.from), Math.min(node.to, window.to))) ? "cm-live-em cm-live-em-ko" : "cm-live-em";
        const className = node.name === "StrongEmphasis" ? "cm-live-strong" : node.name === "Emphasis" ? emphasisClass : node.name === "InlineCode" ? "cm-live-code" : node.name === "Strikethrough" ? "cm-live-strike" : null;
        if (className) add({ kind: "mark", from: node.from, to: node.to, className });
        if (!activeLine(state, node.from)) {
          if (["HeaderMark", "EmphasisMark", "CodeMark", "QuoteMark", "StrikethroughMark"].includes(node.name)) {
            const heading = node.name === "HeaderMark" && /^SetextHeading/.test(node.node.parent?.name ?? "") ? node.node.parent : null;
            // Either half of a Setext heading exposes its underline for editing.
            if (heading && state.selection.ranges.some((range) => state.doc.lineAt(range.from).number <= line.number && state.doc.lineAt(range.to).number >= state.doc.lineAt(heading.from).number)) return;
            if (heading) add({ kind: "line", from: line.from, className: "cm-live-setext-hidden" });
            const to = node.name === "HeaderMark" ? node.to + (/^[ \t]+/.exec(state.sliceDoc(node.to, line.to))?.[0].length ?? 0) : node.to;
            add({ kind: "hide", from: node.from, to, syntax: heading ? "SetextMark" : node.name });
          }
          if (node.name === "ListMark" && !node.node.parent?.getChild("Task") && /^[-*+]$/.test(state.sliceDoc(node.from, node.to))) {
            add({ kind: "bullet", from: node.from, to: node.to });
          }
        }
      },
    });
    const first = state.doc.lineAt(window.from).number;
    const last = state.doc.lineAt(window.to).number;
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number);
      const links = parseWikiLinks(line.text);
      for (const link of links) {
        const from = line.from + link.start, to = line.from + link.end;
        let node: ReturnType<typeof tree.resolve> | null = tree.resolve(from, 1);
        let excluded = false;
        while (node) {
          if (["InlineCode", "FencedCode", "CodeBlock", "Table"].includes(node.name)) { excluded = true; break; }
          node = node.parent;
        }
        if (excluded || activeLine(state, from)) continue;
        // Explicit aliases are display text; only their destination may also be
        // hidden. Plain links retain their target as ordinary visible source text.
        add({ kind: "wiki", from, to, label: link.label ?? link.target, target: link.target + (link.heading ? `#${link.heading}` : "") });
        add({ kind: "hide", from, to: from + 2, syntax: "WikiMark" });
        add({ kind: "hide", from: to - 2, to, syntax: "WikiMark" });
        const pipe = line.text.indexOf("|", link.start);
        if (link.label !== null && pipe !== -1 && pipe < link.end) {
          add({ kind: "hide", from: from + 2, to: line.from + pipe + 1, syntax: "WikiDestination" });
        }
      }
      for (const match of line.text.matchAll(/(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu)) {
        if (!parseInlineTags(match[0]).length) continue;
        const from = line.from + match.index + (match[1] ?? "").length;
        if (links.some((link) => from >= line.from + link.start && from < line.from + link.end)) continue;
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

/** A zero-height underline has no vertical hit target for CM's spatial arrows. */
export function setextStep(state: EditorState, direction: -1 | 1): number | null {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
  const current = state.doc.lineAt(state.selection.main.head);
  const number = current.number + direction;
  if (number < 1 || number > state.doc.lines) return null;
  const next = state.doc.line(number);
  const collapsed = liveRanges(state, [{ from: next.from, to: next.to }]).some((range) => range.kind === "line" && range.className === "cm-live-setext-hidden");
  return collapsed ? next.from + Math.min(state.selection.main.head - current.from, next.length) : null;
}

