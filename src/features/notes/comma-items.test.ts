import { expect, test } from "bun:test";
import { addTags, mergeCommaItems, parseCommaItems, removeTag } from "./comma-items";

test("tag parsing preserves the original field's casing and trims empty comma entries", () => {
  const input = " Work, 한글 , , Work ,#태그 ";
  const parsed = parseCommaItems(input);
  expect(parsed).toEqual(["Work", "한글", "Work", "#태그"]);
});
test("tag adding deduplicates with the original case-sensitive rule", () => {
  const existing = ["Work", "한글"];
  const result = addTags(existing, " 한글, work, 새 태그, ");
  expect(result).toEqual(["Work", "한글", "work", "새 태그"]);
});
test("tag removal removes only the chosen index", () => {
  const existing = ["하나", "둘", "셋"];
  const result = removeTag(existing, 1);
  expect(result).toEqual(["하나", "셋"]);
});
test("empty-input Backspace removes the final tag", () => {
  const existing = ["하나", "둘"];
  const result = removeTag(existing, existing.length - 1);
  expect(result).toEqual(["하나"]);
});
test("acknowledged inline tags survive a comma field commit", () => {
  const result = mergeCommaItems("남김, 새 태그", "남김, 지움", "남김, 지움, 본문");
  expect(result).toEqual(["남김", "새 태그", "본문"]);
});
test("removing from an empty tag list stays empty", () => {
  expect(removeTag([], -1)).toEqual([]);
});
