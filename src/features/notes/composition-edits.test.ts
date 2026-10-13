import { expect, test } from "bun:test";
import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { mapDeferred, sourceChange } from "./composition-edits";

test("maps a deferred task mark through composition without replacing Korean input", () => {
  // Given
  const body = "입력:\n- [ ] 작업";
  const pending = sourceChange(body, body.replace("[ ]", "[x]"));
  const composing = ChangeSet.of({ from: 3, insert: "한" }, body.length);
  // When
  const mapped = mapDeferred({ kind: "change", changes: pending }, composing);
  // Then
  expect(mapped.kind).toBe("change");
  if (mapped.kind === "change") expect(mapped.changes.apply(composing.apply(Text.of(body.split("\n")))).toString()).toBe("입력:한\n- [x] 작업");
});

test("maps command selection through changing preedit lengths", () => {
  const run = () => {};
  const pending = { kind: "command", selection: EditorSelection.single(7), run } as const;
  const mapped = mapDeferred(pending, ChangeSet.of({ from: 1, to: 2, insert: "한글" }, 9));
  expect(mapped.kind === "command" && mapped.selection.main.head).toBe(8);
});

test("an external toggle changes exactly one source character", () => {
  const before = "한글 📝\n- [ ] 작업\n끝";
  const change = sourceChange(before, before.replace("[ ]", "[x]"));
  const edits: object[] = [];
  change.iterChanges((from, to, _fromB, _toB, insert) => edits.push({ from, to, insert: insert.toString() }));
  expect(edits).toEqual([{ from: before.indexOf("[ ]") + 1, to: before.indexOf("[ ]") + 2, insert: "x" }]);
});
