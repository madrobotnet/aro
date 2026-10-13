import { expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { liveTableRanges } from "./live-tables";

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
