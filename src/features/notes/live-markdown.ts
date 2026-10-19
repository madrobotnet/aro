import { syntaxTree } from "@codemirror/language";
import { EditorSelection, Facet, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { parseInlineTags, parseWikiLinks } from "@/lib/wikilinks";
import { parseTasks, toggleTask } from "@/lib/tasks";
import { compositionActive, compositionSettled, deferEdit, sourceChange } from "./composition-edits";
import { isComposing } from "./wikilink-autocomplete";
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

class BulletWidget extends WidgetType {
  toDOM() {
    const node = document.createElement("span");
    node.textContent = "•";
    node.className = "cm-live-bullet";
    node.setAttribute("aria-hidden", "true");
    return node;
  }
}

export function taskChange(state: EditorState, at: number) {
  const body = state.doc.toString();
  const task = parseTasks(body).find((item) => item.line === state.doc.lineAt(at).number);
  if (!task) return null;
  const result = toggleTask(body, { line: task.line, expectedText: task.text, done: !task.done });
  return result.ok && result.changed ? sourceChange(body, result.body) : null;
}

class TaskWidget extends WidgetType {
  constructor(readonly done: boolean, readonly label: string) { super(); }
  eq(other: TaskWidget) { return this.done === other.done && this.label === other.label; }
  updateDOM(dom: HTMLElement) {
    const input = dom.querySelector("input");
    if (!input) return false;
    input.checked = this.done;
    input.setAttribute("aria-label", this.label);
    return true;
  }
  toDOM(view: EditorView) {
    const label = document.createElement("label");
    label.className = "cm-live-task";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.done;
    input.setAttribute("aria-label", this.label);
    label.append(input);
    label.addEventListener("mousedown", (event) => event.preventDefault());
    input.addEventListener("click", (event) => {
      // Native activation owns the immediate checked state. Cancel it only
      // during composition, when the source toggle is queued rather than applied.
      if (isComposing(view)) event.preventDefault();
      const anchor = view.posAtDOM(label);
      deferEdit(view, { kind: "command", selection: EditorSelection.single(anchor), run(current, selection) {
        const changes = taskChange(current.state, selection.main.head);
        if (changes) current.dispatch({ changes, userEvent: "input.task" });
      } });
    });
    return label;
  }
  ignoreEvent() { return true; }
}

export function liveDecorations(state: EditorState, windows: readonly LiveWindow[]): DecorationSet {
  const ranges: Range<Decoration>[] = liveRanges(state, windows).map((range) => {
    switch (range.kind) {
      case "hide": return Decoration.replace({}).range(range.from, range.to);
      case "bullet": return Decoration.replace({ widget: new BulletWidget() }).range(range.from, range.to);
      case "task": return Decoration.replace({ widget: new TaskWidget(range.done, range.label) }).range(range.from, range.to);
      case "wiki": return Decoration.mark({ class: "cm-live-wiki", attributes: { role: "button", tabindex: "0", contenteditable: "false", title: range.target, "aria-label": state.facet(liveLabels).wikiLabel(range.label, range.target) } }).range(range.from, range.to);
      case "link": return Decoration.mark({ tagName: range.url ? "a" : "span", class: "cm-live-link", attributes: { role: "link", tabindex: "0", "aria-haspopup": "dialog", ...(range.url ? { href: range.url, target: "_blank", rel: "noopener noreferrer" } : {}), title: range.url, "aria-label": `${range.label}, ${range.url}` } }).range(range.from, range.to);
      case "line": return Decoration.line({ class: range.className }).range(range.from);
      case "mark": return Decoration.mark({ class: range.className }).range(range.from, range.to);
    }
  });
  return Decoration.set(ranges, true);
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

const livePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  popover: HTMLElement | null = null;
  readonly closePopover = () => {
    if (!this.popover) return;
    this.popover.remove();
    this.popover = null;
    this.view.focus();
  };
  readonly outsidePress = (event: Event) => {
    if (event.target instanceof Node && !this.popover?.contains(event.target)) this.closePopover();
  };
  readonly dismissKey = (event: KeyboardEvent) => {
    if (!this.popover) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closePopover();
    } else if (!event.ctrlKey && !event.metaKey && (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete")) {
      // Space activates a focused action like any other native button.
      if (event.key !== " ") this.closePopover();
    }
  };
  showPopover(link: HTMLElement) {
    if (isComposing(this.view) || this.view.state.field(compositionActive, false)) return;
    this.closePopover();
    const anchor = this.view.posAtDOM(link, 0);
    const copy = this.view.state.facet(liveLabels);
    const panel = document.createElement("div");
    panel.className = "cm-link-popover surface-card shadow-pop p-1 text-sm text-ink";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", copy.linkActions);
    panel.contentEditable = "false";
    panel.popover = "manual";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = copy.openLink;
    open.className = "min-h-11 min-w-11 rounded-ctl px-4 hover:bg-canvas disabled:opacity-50";
    const url = link.getAttribute("href");
    open.disabled = !url;
    open.addEventListener("click", () => {
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      this.closePopover();
    });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = copy.editLink;
    edit.className = open.className;
    edit.addEventListener("click", () => {
      this.closePopover();
      this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
      this.view.focus();
    });
    panel.append(open, edit);
    this.view.dom.append(panel);
    this.popover = panel;
    panel.showPopover();
    // The top layer avoids editor clipping. Bound it to the visual viewport,
    // excluding the dock whether it is at the bottom or under the phone header.
    const rect = link.getBoundingClientRect(), size = panel.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 8;
    const right = left + (viewport?.width ?? window.innerWidth) - 16;
    let top = (viewport?.offsetTop ?? 0) + 8;
    let bottom = top + (viewport?.height ?? window.innerHeight) - 16;
    const dock = this.view.dom.closest("section")?.querySelector(".editor-format-dock");
    const toolbar = dock?.firstElementChild;
    if (toolbar && getComputedStyle(toolbar).visibility !== "hidden") {
      const bounds = toolbar.getBoundingClientRect();
      if (dock?.getAttribute("data-keyboard") === "open") top = Math.max(top, bounds.bottom + 8);
      else bottom = Math.min(bottom, bounds.top - 8);
    }
    panel.style.left = `${Math.max(left, Math.min(rect.left, right - size.width))}px`;
    panel.style.top = `${Math.max(top, Math.min(rect.bottom + 6 + size.height <= bottom ? rect.bottom + 6 : rect.top - size.height - 6, bottom - size.height))}px`;
    (open.disabled ? edit : open).focus({ preventScroll: true });
  }
  readonly linkClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element) || event.button !== 0) return;
    const link = event.target.closest<HTMLAnchorElement>(".cm-live-link");
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    if (isComposing(this.view) || this.view.state.field(compositionActive, false) || event.type !== "click") return;
    if (event.ctrlKey || event.metaKey) {
      this.closePopover();
      if (link.getAttribute("href")) window.open(link.href, "_blank", "noopener,noreferrer");
    } else this.showPopover(link);
  };
  readonly chipKey = (event: KeyboardEvent) => {
    if (event.isComposing || isComposing(this.view) || this.view.state.field(compositionActive, false) || !(event.target instanceof HTMLElement)) return;
    const link = event.target.closest<HTMLAnchorElement>(".cm-live-link");
    if (link && (event.key === "ArrowDown" || event.key === " ")) {
      event.preventDefault();
      event.stopPropagation();
      this.showPopover(link);
      return;
    }
    if (event.target === this.view.contentDOM && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const anchor = setextStep(this.view.state, event.key === "ArrowUp" ? -1 : 1);
      if (anchor !== null) {
        event.preventDefault();
        event.stopPropagation();
        this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
        return;
      }
    }
    if (event.key !== "Enter") return;
    if (link) {
      event.preventDefault();
      event.stopPropagation();
      if (link.getAttribute("href")) window.open(link.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (!event.target.classList.contains("cm-live-wiki")) return;
    // A focused chip is a control, not an IME text target. Handle its activation
    // before CM's keydown forceFlush recycles the marked span into source text.
    event.preventDefault();
    event.stopPropagation();
    this.view.dispatch({ selection: { anchor: this.view.posAtDOM(event.target, 0) } });
    this.view.focus();
  };
  constructor(readonly view: EditorView) {
    this.decorations = liveDecorations(view.state, liveWindows(view.state, view.visibleRanges));
    view.contentDOM.addEventListener("keydown", this.chipKey, true);
    view.contentDOM.addEventListener("click", this.linkClick, true);
    view.contentDOM.addEventListener("mousedown", this.linkClick, true);
    view.contentDOM.addEventListener("pointerdown", this.linkClick, true);
    document.addEventListener("pointerdown", this.outsidePress, true);
    document.addEventListener("keydown", this.dismissKey, true);
    document.addEventListener("compositionstart", this.closePopover, true);
    document.addEventListener("beforeinput", this.closePopover, true);
    document.addEventListener("scroll", this.closePopover, true);
    window.addEventListener("resize", this.closePopover);
    window.visualViewport?.addEventListener("resize", this.closePopover);
    window.visualViewport?.addEventListener("scroll", this.closePopover);
  }
  destroy() {
    this.popover?.remove();
    this.view.contentDOM.removeEventListener("keydown", this.chipKey, true);
    this.view.contentDOM.removeEventListener("click", this.linkClick, true);
    this.view.contentDOM.removeEventListener("mousedown", this.linkClick, true);
    this.view.contentDOM.removeEventListener("pointerdown", this.linkClick, true);
    document.removeEventListener("pointerdown", this.outsidePress, true);
    document.removeEventListener("keydown", this.dismissKey, true);
    document.removeEventListener("compositionstart", this.closePopover, true);
    document.removeEventListener("beforeinput", this.closePopover, true);
    document.removeEventListener("scroll", this.closePopover, true);
    window.removeEventListener("resize", this.closePopover);
    window.visualViewport?.removeEventListener("resize", this.closePopover);
    window.visualViewport?.removeEventListener("scroll", this.closePopover);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.startState.facet(liveRaw) !== update.state.facet(liveRaw) || update.startState.facet(liveLabels) !== update.state.facet(liveLabels)) this.closePopover();
    // Mapping preserves the composing DOM. The incremental Lezer tree is reused
    // on ordinary edits; only the visible windows are visited to build decorations.
    if (isComposing(update.view) || update.state.field(compositionActive, false)) { this.decorations = this.decorations.map(update.changes); return; }
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.startState.facet(liveRaw) !== update.state.facet(liveRaw) || update.startState.facet(liveLabels) !== update.state.facet(liveLabels) || syntaxTree(update.startState) !== syntaxTree(update.state) || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(compositionSettled)))) {
      this.decorations = liveDecorations(update.state, liveWindows(update.state, update.view.visibleRanges));
    }
  }
}, { decorations: (plugin) => plugin.decorations });

const liveTheme = EditorView.baseTheme({
  ".cm-live-h1": { fontSize: "var(--text-2xl)", fontWeight: "700" },
  ".cm-live-h2": { fontSize: "var(--text-xl)", fontWeight: "700" },
  "& .cm-line.cm-live-setext-hidden": { height: "0", minHeight: "0", lineHeight: "0", overflow: "hidden" },
  ".cm-live-h3, .cm-live-h4, .cm-live-h5, .cm-live-h6": { fontSize: "var(--text-lg)", fontWeight: "600" },
  ".cm-live-strong": { fontWeight: "700" },
  ".cm-live-em": { fontStyle: "italic" },
  ".cm-live-em-ko": { textDecoration: "underline dotted var(--mute)", textUnderlineOffset: "0.2em" },
  ".cm-live-strike": { textDecoration: "line-through" },
  ".cm-live-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "0.15em", cursor: "pointer" },
  ".cm-live-link:focus-visible": { outline: "2px solid var(--focus)", outlineOffset: "2px" },
  ".cm-link-popover": { position: "fixed", inset: "auto", margin: "0", maxWidth: "calc(100vw - 16px)", fontFamily: "var(--font-sans)" },
  ".cm-live-code": { fontFamily: "var(--font-mono)", backgroundColor: "var(--desk)", borderRadius: "var(--radius-ctl)" },
  ".cm-live-tag": { color: "var(--accent)", backgroundColor: "var(--accent-soft)", borderRadius: "var(--radius-pill)" },
  ".cm-live-quote": { borderLeft: "2px solid var(--line-strong)", paddingLeft: "1rem", color: "var(--mute)" },
  ".cm-live-bullet": { color: "var(--mute)" },
  ".cm-live-task": { display: "inline-flex", alignItems: "center", minHeight: "var(--text-read-leading)", verticalAlign: "middle", marginRight: "0.5rem" },
  ".cm-live-task input": { width: "1rem", height: "1rem", margin: "0", accentColor: "var(--accent)", cursor: "pointer" },
  ".cm-live-done": { color: "var(--mute)", textDecoration: "line-through" },
  ".cm-live-wiki": { color: "var(--accent)", backgroundColor: "var(--accent-soft)", borderRadius: "var(--radius-ctl)", padding: "0.125rem 0.25rem", cursor: "text", boxDecorationBreak: "clone" },
  "& .cm-line.cm-live-fence": { backgroundColor: "var(--desk)", fontFamily: "var(--font-mono)", padding: "0 0.5rem" },
  ".cm-live-code-info": { fontFamily: "var(--font-sans)", fontSize: "var(--text-xs)", color: "var(--mute)", fontWeight: "600" },
});

export function liveMarkdown() {
  return [livePlugin, liveTheme];
}
