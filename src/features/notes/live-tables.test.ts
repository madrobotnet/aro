import { expect, spyOn, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LiveTableViewport, liveTableRanges, liveTables } from "./live-tables";
import { compositionActive } from "./composition-edits";
import { liveRaw } from "./live-markdown";

const doc = "| 단계 | 상태 |\n| --- | --- |\n| 문서 | 진행 중 |\n\n끝";
function state(anchor: number) { return EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage })] }); }

test("renders every simple GFM cell without changing its stored source", () => {
  const before = state(doc.length);
  const tables = liveTableRanges(before, [{ from: 0, to: doc.length }]);
  expect(tables).toHaveLength(1);
  expect(tables[0]?.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([["단계", "상태"], ["문서", "진행 중"]]);
  expect(before.doc.toString()).toBe(doc);
});

test("shows raw table source when the cursor or selection touches it", () => {
  expect(liveTableRanges(state(29), [{ from: 0, to: doc.length }])).toEqual([]);
  const selected = state(doc.length).update({ selection: { anchor: 0, head: doc.length } }).state;
  expect(liveTableRanges(selected, [{ from: 0, to: doc.length }])).toEqual([]);
});

test("excludes offscreen tables and finds a table crossing a visible range", () => {
  expect(liveTableRanges(state(doc.length), [{ from: doc.length, to: doc.length }])).toEqual([]);
  expect(liveTableRanges(state(doc.length), [{ from: 28, to: 32 }])).toHaveLength(1);
});

test("raw mode does not replace table source", () => {
  const raw = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdown({ base: markdownLanguage }), liveRaw.of(true)] });
  expect(liveTableRanges(raw, [{ from: 0, to: doc.length }])).toEqual([]);
});

/** The real plugin and StateField, with the measurement lock and later queue
 * controlled explicitly. Dispatch inside write reproduces EditorView's lock.
 */
function measuredViewport(source = Array.from({ length: 120 }, (_, i) => `Line ${i}`).join("\n")) {
  let current = EditorState.create({
    doc: source,
    extensions: [markdown({ base: markdownLanguage }), liveTables(), compositionActive],
  });
  let viewport = { from: current.doc.line(70).from, to: current.doc.line(75).to };
  let visible = [viewport];
  let composing = false;
  let measuring = false;
  let dispatched = 0;
  const measures: (() => void)[] = [];
  const later: VoidFunction[] = [];
  const scheduler = spyOn(globalThis, "queueMicrotask").mockImplementation((run) => { later.push(run); });
  const view: EditorView = Object.create(EditorView.prototype);
  Object.defineProperties(view, {
    state: { get: () => current },
    viewport: { get: () => viewport },
    visibleRanges: { get: () => visible },
    composing: { get: () => composing },
    compositionStarted: { get: () => false },
  });
  view.requestMeasure = (request) => {
    if (!request) throw new Error("Expected a measurement");
    measures.push(() => {
      measuring = true;
      try { request.write?.(request.read(view), view); }
      finally { measuring = false; }
    });
  };
  const dispatchTransactions = (transactions: readonly Transaction[]) => {
    if (measuring) throw new Error("Calls to EditorView.update are not allowed while an update is in progress");
    dispatched += 1;
    for (const transaction of transactions) current = transaction.state;
  };
  Object.defineProperty(view, "dispatchTransactions", { value: dispatchTransactions });
  const plugin = new LiveTableViewport(view);
  return {
    plugin, view,
    measure: () => { for (const run of measures.splice(0)) run(); },
    flush: () => { for (const run of later.splice(0)) run(); },
    dispose: () => scheduler.mockRestore(),
    get dispatched() { return dispatched; },
    get queued() { return later.length; },
    get state() { return current; },
    setVisible: (ranges: typeof visible) => {
      visible = ranges;
      const first = ranges[0], last = ranges.at(-1);
      if (first && last) viewport = { from: first.from, to: last.to };
    },
    setViewport: (range: typeof viewport) => { viewport = range; },
    compose: (active: boolean) => { composing = active; },
    edit: (insert: string) => { current = current.update({ changes: { from: 0, to: current.doc.length, insert } }).state; },
  };
}

test("keeps a block table when its replacement excludes source from visible ranges", () => {
  // Given: the viewport is inside a rendered table, whose replaced source is not visible.
  const prefix = "Before\n\n";
  const table = ["| Name | Value |", "| --- | --- |", ...Array.from({ length: 80 }, (_, i) => `| Row ${i} | Value ${i} |`)].join("\n");
  const measured = measuredViewport(`${prefix}${table}\n\nAfter`);
  try {
    measured.setVisible([]);
    measured.setViewport({ from: prefix.length, to: prefix.length + table.length });
    // When: the real plugin refreshes its StateField after viewport measurement.
    measured.measure();
    measured.flush();
    // Then: the table's replacement remains, rather than changing the reader's layout.
    const decoration = measured.state.facet(EditorView.decorations)[0];
    if (!decoration || typeof decoration === "function") throw new Error("Expected direct table decorations");
    expect(decoration.size).toBe(1);
  } finally { measured.dispose(); }
});

test("table measurement coalesces changed windows outside the view update lock", () => {
  const measured = measuredViewport();
  try {
    measured.measure();
    measured.plugin.measure(measured.view);
    measured.measure();

    expect(measured.dispatched).toBe(0);
    expect(measured.queued).toBe(1);
    measured.flush();
    expect(measured.dispatched).toBe(1);
    measured.plugin.measure(measured.view);
    measured.measure();
    measured.flush();
    expect(measured.dispatched).toBe(1);
  } finally { measured.dispose(); }
});

test.each([30, 180])("table flush recomputes windows after the document changes to %i lines", (lines) => {
  const measured = measuredViewport();
  try {
    measured.measure();
    measured.edit(Array.from({ length: lines }, (_, i) => `Changed ${i}`).join("\n"));
    measured.setVisible([{ from: measured.state.doc.line(10).from, to: measured.state.doc.line(15).to }]);

    expect(() => measured.flush()).not.toThrow();
    expect(measured.dispatched).toBe(1);
    measured.plugin.measure(measured.view);
    measured.measure();
    measured.flush();
    expect(measured.dispatched).toBe(1);
  } finally { measured.dispose(); }
});

test("table flush leaves composition untouched until a later settled measurement", () => {
  const measured = measuredViewport();
  try {
    measured.measure();
    measured.compose(true);
    measured.flush();
    expect(measured.dispatched).toBe(0);

    measured.compose(false);
    measured.plugin.measure(measured.view);
    measured.measure();
    measured.flush();
    expect(measured.dispatched).toBe(1);
  } finally { measured.dispose(); }
});

test("destroyed table plugins never flush a queued transaction", () => {
  const measured = measuredViewport();
  try {
    measured.measure();
    measured.plugin.destroy();

    measured.flush();
    expect(measured.dispatched).toBe(0);
  } finally { measured.dispose(); }
});
