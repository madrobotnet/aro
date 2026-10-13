import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { formatTransaction, type FormatAction } from "./editor-format";

test.each([
  ["heading", "한국어", "## 한국어", 2, 5],
  ["heading", "## 한국어", "### 한국어", 5, 6],
  ["heading", "### 한국어", "한국어", 6, 2],
  ["bullet", "한국어", "- 한국어", 2, 4],
  ["bullet", "- 한국어", "한국어", 4, 2],
  ["task", "한국어", "- [ ] 한국어", 2, 8],
  ["task", "- [x] 한국어", "한국어", 8, 2],
  ["code", "한국어", "한국``어", 2, 3],
  ["wiki", "한국어", "한국[[어", 2, 4],
] satisfies readonly (readonly [FormatAction, string, string, number, number])[])("%s transforms the Korean current line and maps the cursor", (action, doc, expected, cursor, head) => {
  // Given
  const state = EditorState.create({ doc, selection: { anchor: cursor } });
  // When
  const next = state.update(formatTransaction(state, action)).state;
  // Then
  expect(next.doc.toString()).toBe(expected);
  expect(next.selection.main.head).toBe(head);
});

test.each([
  ["heading", "## 하나\n## 둘\n셋", 11],
  ["bullet", "- 하나\n- 둘\n셋", 9],
  ["task", "- [ ] 하나\n- [ ] 둘\n셋", 17],
] satisfies readonly (readonly [FormatAction, string, number])[])("%s changes selected lines without including the next line boundary", (action, expected, head) => {
  const state = EditorState.create({ doc: "하나\n둘\n셋", selection: { anchor: 0, head: 5 } });
  const next = state.update(formatTransaction(state, action)).state;
  expect(next.doc.toString()).toBe(expected);
  expect(next.selection.main.from).toBe(action === "heading" ? 3 : action === "bullet" ? 2 : 6);
  expect(next.selection.main.head).toBe(head);
});

test.each([
  ["code", "앞 `한국어` 뒤", 3, 6],
  ["wiki", "앞 [[한국어 뒤", 4, 7],
] satisfies readonly (readonly [FormatAction, string, number, number])[])("%s preserves the selected Korean text and places selection inside the inserted syntax", (action, expected, from, to) => {
  const state = EditorState.create({ doc: "앞 한국어 뒤", selection: { anchor: 2, head: 5 } });
  const next = state.update(formatTransaction(state, action)).state;
  expect(next.doc.toString()).toBe(expected);
  expect([next.selection.main.from, next.selection.main.to]).toEqual([from, to]);
});

test("line transformations preserve indentation and reverse selections", () => {
  const state = EditorState.create({ doc: "  - 하나\n  둘", selection: { anchor: 10, head: 4 } });
  const next = state.update(formatTransaction(state, "task")).state;
  expect(next.doc.toString()).toBe("  - [ ] 하나\n  - [ ] 둘");
  expect(next.selection.main.anchor).toBeGreaterThan(next.selection.main.head);
});

test.each(["heading", "bullet", "task", "code", "wiki"] as const)("%s creates a real undoable CodeMirror transaction", (action) => {
  let state = EditorState.create({ doc: "한글", selection: { anchor: 1 }, extensions: [history()] });
  state = state.update(formatTransaction(state, action)).state;
  const result = undo({ state, dispatch: (transaction) => { state = transaction.state; } });
  expect(result).toBe(true);
  expect(state.doc.toString()).toBe("한글");
  expect(state.selection.main.head).toBe(1);
});
