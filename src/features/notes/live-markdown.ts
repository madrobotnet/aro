import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { parseTasks, toggleTask } from "@/lib/tasks";
import { compositionActive, compositionSettled, deferEdit, sourceChange } from "./composition-edits";
import { isComposing } from "./wikilink-autocomplete";
import { liveRanges, liveRaw, liveWindows, liveLabels, setextStep, type LiveWindow } from "./live-markdown-ranges";
import { LiveLinkPopover } from "./live-markdown-popover";
import { liveTheme } from "./live-markdown-theme";

export { liveRanges, liveRaw, liveWindows, liveLabels, setextStep } from "./live-markdown-ranges";
export type { LiveWindow, LiveRange } from "./live-markdown-ranges";

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

const livePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  readonly links: LiveLinkPopover;
  readonly chipKey = (event: KeyboardEvent) => {
    if (event.isComposing || isComposing(this.view) || this.view.state.field(compositionActive, false) || !(event.target instanceof HTMLElement)) return;
    const link = event.target.closest<HTMLAnchorElement>(".cm-live-link");
    if (link && (event.key === "ArrowDown" || event.key === " ")) {
      event.preventDefault();
      event.stopPropagation();
      this.links.showPopover(link);
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
    this.links = new LiveLinkPopover(view);
    view.contentDOM.addEventListener("keydown", this.chipKey, true);
  }
  destroy() {
    this.links.destroy();
    this.view.contentDOM.removeEventListener("keydown", this.chipKey, true);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.startState.facet(liveRaw) !== update.state.facet(liveRaw) || update.startState.facet(liveLabels) !== update.state.facet(liveLabels)) this.links.closePopover();
    // Mapping preserves the composing DOM. The incremental Lezer tree is reused
    // on ordinary edits; only the visible windows are visited to build decorations.
    if (isComposing(update.view) || update.state.field(compositionActive, false)) { this.decorations = this.decorations.map(update.changes); return; }
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.startState.facet(liveRaw) !== update.state.facet(liveRaw) || update.startState.facet(liveLabels) !== update.state.facet(liveLabels) || syntaxTree(update.startState) !== syntaxTree(update.state) || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(compositionSettled)))) {
      this.decorations = liveDecorations(update.state, liveWindows(update.state, update.view.visibleRanges));
    }
  }
}, { decorations: (plugin) => plugin.decorations });

export function liveMarkdown() {
  return [livePlugin, liveTheme];
}
