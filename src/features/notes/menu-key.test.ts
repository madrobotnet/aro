import { expect, test } from "bun:test";
import { menuKeyIndex } from "./menu-key";

test.each([
  ["ArrowDown", 3, 0], ["ArrowUp", 0, 3], ["ArrowDown", -1, 0],
  ["Home", 2, 0], ["End", 0, 3], ["Enter", 2, null], ["Escape", 2, null],
] as const)("%s maps menu focus from index %s", (key, current, expected) => {
  expect(menuKeyIndex(key, current, 4)).toBe(expected);
});
