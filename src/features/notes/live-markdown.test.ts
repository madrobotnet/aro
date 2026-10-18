import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { parseWikiLinks } from "@/lib/wikilinks";
import { liveRanges, liveRaw, liveWindows, taskChange } from "./live-markdown";
import { editorLanguage } from "./editor-language";

function state(doc: string, anchor = doc.length) {
  return EditorState.create({ doc, selection: { anchor }, extensions: [editorLanguage()] });
}

test.each([
  ["# 제목\n끝", "#"], ["## 제목\n끝", "##"], ["###### 제목\n끝", "######"],
  ["**한글**\n끝", "**"], ["_한글_\n끝", "_"], ["`코드`\n끝", "`"], ["> 인용\n끝", ">"],
])("reveals %s syntax only on the selected line", (doc, syntax) => {
  // Given / When
  const off = liveRanges(state(doc), [{ from: 0, to: doc.length }]);
  const on = liveRanges(state(doc, 0), [{ from: 0, to: doc.length }]);
  // Then
  expect(off.filter((range) => range.kind === "hide").map((range) => doc.slice(range.from, range.to))).toContain(syntax.startsWith("#") ? syntax + " " : syntax);
  expect(on.filter((range) => range.kind === "hide")).toEqual([]);
});

test("styles tags, bullets and quotes but excludes code and wiki targets", () => {
  const doc = "- 글 #출시\n> 인용\n`#코드` [[문서#제목]]\n```\n#숨김\n```\n끝";
  const ranges = liveRanges(state(doc), [{ from: 0, to: doc.length }]);
  expect(ranges.filter((range) => range.kind === "bullet")).toHaveLength(1);
  expect(ranges.flatMap((range) => range.kind === "mark" && range.className === "cm-live-tag" ? [doc.slice(range.from, range.to)] : [])).toEqual(["#출시"]);
  expect(ranges.some((range) => range.kind === "line" && range.className === "cm-live-quote")).toBe(true);
});

test("every hidden range contains only its construct's syntax across a Markdown corpus", () => {
  const samples = ["한글 English 42 📝", "제목", "한_글", "<script>", "a|b", "태그/문서"];
  const syntax = { HeaderMark: /^#+[ \t]*$/, EmphasisMark: /^[*_]+$/, CodeMark: /^`+$/, FenceMark: /^(?:`{3,}|~{3,})$/, QuoteMark: /^>$/, WikiMark: /^(?:\[\[|\]\])$/ };
  for (const text of samples) {
    for (const prefix of ["", "> ", "- "]) {
      const doc = `${prefix}# ${text}\n\n${prefix}**${text}** _${text}_ \`${text}\`\n\n[[문서|${text}]]\n\n- [ ] ${text}\n- ${text}\n\n\`\`\`${text}\n${text}\n\`\`\`\n끝`;
      const ranges = liveRanges(state(doc), [{ from: 0, to: doc.length }]);
      for (const range of ranges) {
        if (range.kind === "bullet") expect(/^[-*+]$/.test(doc.slice(range.from, range.to))).toBe(true);
        if (range.kind === "task") expect(/^(?:[-*+]|\d+[.)])[ \t]+\[[ \txX]\][ \t]*$/.test(doc.slice(range.from, range.to))).toBe(true);
        if (range.kind !== "hide") continue;
        if (range.syntax === "WikiDestination") {
          const link = parseWikiLinks(doc).find((link) => link.start + 2 === range.from && link.label !== null);
          expect(link).toBeDefined();
          expect(range.to).toBe(doc.indexOf("|", range.from) + 1);
          continue;
        }
        const pattern = Object.entries(syntax).find(([name]) => name === range.syntax)?.[1];
        expect(pattern?.test(doc.slice(range.from, range.to))).toBe(true);
      }
    }
  }
});

test.each(["```한글 English42", "~~~~한글42 title", "```js title=한국어"])("keeps the entire %s fence info string visible after leaving its line", (opening) => {
  const fence = opening.startsWith("~") ? "~~~~" : "```";
  const doc = `${opening}\nconst a = "#태그 [[코드]]";\n${fence}\n끝`;
  const ranges = liveRanges(state(doc), [{ from: 0, to: doc.length }]);
  expect(ranges.flatMap((range) => range.kind === "hide" ? [doc.slice(range.from, range.to)] : [])).toEqual([fence, fence]);
  expect(ranges.flatMap((range) => range.kind === "mark" && range.className === "cm-live-code-info" ? [doc.slice(range.from, range.to)] : [])).toEqual([opening.slice(fence.length)]);
  expect(liveRanges(state(doc, opening.length), [{ from: 0, to: doc.length }]).filter((range) => range.kind === "hide" && range.from === 0)).toEqual([]);
});

test("wiki chips hide only an explicitly aliased destination and never a plain target", () => {
  const doc = "관련 [[제품#일정|표시 이름]] [[문서]]\n끝";
  const ranges = liveRanges(state(doc), [{ from: 0, to: doc.length }]);
  expect(ranges.flatMap((range) => range.kind === "wiki" ? [range.label] : [])).toEqual(["표시 이름", "문서"]);
  const hidden = ranges.flatMap((range) => range.kind === "hide" ? [doc.slice(range.from, range.to)] : []);
  expect(hidden).toEqual(["[[", "]]", "제품#일정|", "[[", "]]"]);
  const plainFrom = doc.indexOf("문서");
  expect(ranges.some((range) => range.kind === "hide" && range.from < plainFrom + 2 && range.to > plainFrom)).toBe(false);
  expect(liveRanges(state(doc, 5), [{ from: 0, to: doc.length }]).filter((range) => range.kind === "wiki")).toEqual([]);
  const code = "`[[코드]]`\n~~~\n[[펜스]]\n~~~\n끝";
  expect(liveRanges(state(code), [{ from: 0, to: code.length }]).filter((range) => range.kind === "wiki")).toEqual([]);
});

test("bounds work to the viewport and updates syntax after a local edit", () => {
  const doc = Array.from({ length: 5000 }, (_, i) => `# 제목 ${i}`).join("\n");
  const before = state(doc);
  const visible = { from: before.doc.line(2500).from, to: before.doc.line(2510).to };
  const windows = liveWindows(before, [visible]);
  expect(windows[0]?.from).toBe(before.doc.line(2496).from);
  expect(windows[0]?.to).toBe(before.doc.line(2514).to);
  let changed = before.update({ changes: { from: visible.from, insert: "#" } }).state;
  ensureSyntaxTree(changed, visible.to + 100, 1000);
  changed = changed.update({}).state;
  const ranges = liveRanges(changed, liveWindows(changed, [visible]));
  expect(ranges.length).toBeLessThan(100);
  expect(ranges.some((range) => range.kind === "line" && range.from === visible.from && range.className === "cm-live-h2")).toBe(true);
});

test("recognizes nested tasks with the shared scanner and skips quoted/code tasks", () => {
  const doc = "- [ ] 부모\n  - [x] 자식\n    - [ ] 깊은 자식\n\n> - [ ] 인용\n\n    - [ ] 코드\n\n~~~md\n- [ ] 펜스\n~~~\n끝";
  const ranges = liveRanges(state(doc), [{ from: 0, to: doc.length }]);
  expect(ranges.flatMap((range) => range.kind === "task" ? [range.label] : [])).toEqual(["부모", "자식", "깊은 자식"]);
  expect(liveRanges(state(doc, 3), [{ from: 0, to: doc.length }]).flatMap((range) => range.kind === "task" ? [range.label] : [])).toEqual(["자식", "깊은 자식"]);
});

test("checkbox toggles only one character through the shared task scanner", () => {
  const doc = "# 제목\n- [ ] 한글 **작업**\n끝";
  const before = state(doc);
  const changes = taskChange(before, doc.indexOf("-"));
  expect(changes).not.toBeNull();
  if (!changes) return;
  expect(changes.apply(before.doc).toString()).toBe(doc.replace("[ ]", "[x]"));
  expect(changes.desc.toString()).toContain("1:1");
  expect(taskChange(state("```\n- [ ] 코드\n```"), 5)).toBeNull();
});

test("raw mode has no live decorations and preserves source and selection", () => {
  const doc = "# 한글\n- [ ] 할 일\n[[문서|표시]]\n```한글42\n코드\n```";
  const before = EditorState.create({ doc, selection: { anchor: 2 }, extensions: [editorLanguage(), liveRaw.of(true)] });
  expect(liveRanges(before, [{ from: 0, to: doc.length }])).toEqual([]);
  expect(before.doc.toString()).toBe(doc);
  expect(before.selection.main.head).toBe(2);
});

test.each(["#", "##", "###"])("hides the %s delimiter space off-line and reveals the exact prefix on-line", (prefix) => {
  const doc = `${prefix} 제목\n본문`;
  const off = liveRanges(state(doc), [{ from: 0, to: doc.length }]);
  expect(off.find((range) => range.kind === "hide" && range.from === 0)).toEqual({ kind: "hide", from: 0, to: prefix.length + 1, syntax: "HeaderMark" });
  expect(liveRanges(state(doc, prefix.length + 1), [{ from: 0, to: doc.length }]).some((range) => range.kind === "hide" && range.from === 0)).toBe(false);
});

test("done styling begins at the first non-space character, not the checkbox gap", () => {
  const doc = "- [x] \t  이름 변경 반영\n끝";
  const ranges = liveRanges(state(doc), [{ from: 0, to: doc.length }]);
  const mark = ranges.find((range) => range.kind === "mark" && range.className === "cm-live-done");
  expect(mark?.from).toBe(doc.indexOf("이름"));
  const task = ranges.find((range) => range.kind === "task");
  expect(task && task.kind === "task" && task.to).toBe(doc.indexOf("이름"));
});

test.each([["===", "cm-live-h1"], ["---", "cm-live-h2"]])("styles Setext %s text and reveals its underline from either line", (underline, className) => {
  // Given
  const doc = `한글 제목\n${underline}\n\n끝`;
  const window = [{ from: 0, to: doc.length }];
  // When
  const off = liveRanges(state(doc), window);
  const onText = liveRanges(state(doc, 2), window);
  const onUnderline = liveRanges(state(doc, doc.indexOf(underline) + 1), window);
  // Then
  expect(off).toContainEqual({ kind: "line", from: 0, className });
  expect(off.filter((range) => range.kind === "hide")).toEqual([{ kind: "hide", from: doc.indexOf(underline), to: doc.indexOf(underline) + underline.length, syntax: "SetextMark" }]);
  for (const ranges of [onText, onUnderline]) expect(ranges.filter((range) => range.kind === "hide")).toEqual([]);
});

test("Setext styling is bounded when a multiline heading crosses a visible window", () => {
  // Given
  const doc = "첫 줄\n둘째 줄\n셋째 줄\n===\n\n끝";
  const before = state(doc);
  const window = [{ from: before.doc.line(2).from, to: before.doc.line(2).to }];
  // When
  const ranges = liveRanges(before, window);
  // Then
  expect(ranges.filter((range) => range.kind === "line")).toEqual([{ kind: "line", from: before.doc.line(2).from, className: "cm-live-h1" }]);
});

test.each(["1. [ ] 한글 작업", "2) [x] 완료한 작업", "  12. [X] 중첩 작업"])("keeps the number and gaps of ordered task %s", (item) => {
  // Given
  const doc = `${item}\n\n끝`;
  const before = state(doc);
  // When
  const ranges = liveRanges(before, [{ from: 0, to: doc.length }]);
  const task = ranges.find((range) => range.kind === "task");
  const change = task && taskChange(before, task.from);
  // Then
  expect(task && doc.slice(task.from, task.to)).toBe(item.match(/\[[ xX]\]/)?.[0]);
  expect(ranges.some((range) => range.kind === "hide" && range.from < doc.indexOf("["))).toBe(false);
  expect(change?.apply(before.doc).toString()).toBe(doc.replace(/\[[ xX]\]/, item.includes("[ ]") ? "[x]" : "[ ]"));
  expect(liveRanges(state(doc, item.length), [{ from: 0, to: doc.length }]).some((range) => range.kind === "task")).toBe(false);
});
