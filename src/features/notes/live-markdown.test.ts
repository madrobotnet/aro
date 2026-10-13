import { expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { liveRanges, liveWindows } from "./live-markdown";

function state(doc: string, anchor = doc.length) {
  return EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage })] });
}

test.each([
  ["# 제목\n끝", "#"], ["## 제목\n끝", "##"], ["###### 제목\n끝", "######"],
  ["**한글**\n끝", "**"], ["_한글_\n끝", "_"], ["`코드`\n끝", "`"], ["> 인용\n끝", ">"],
])("reveals %s syntax only on the selected line", (doc, syntax) => {
  // Given / When
  const off = liveRanges(state(doc), [{ from: 0, to: doc.length }]);
  const on = liveRanges(state(doc, 0), [{ from: 0, to: doc.length }]);
  // Then
  expect(off.filter((range) => range.kind === "hide").map((range) => doc.slice(range.from, range.to))).toContain(syntax);
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
  const syntax = { HeaderMark: /^#+$/, EmphasisMark: /^[*_]+$/, CodeMark: /^`+$/, QuoteMark: /^>$/ };
  for (const text of samples) {
    for (const prefix of ["", "> ", "- "]) {
      const doc = `${prefix}# ${text}\n\n${prefix}**${text}** _${text}_ \`${text}\`\n\n\`\`\`${text}\n${text}\n\`\`\`\n끝`;
      const ranges = liveRanges(state(doc), [{ from: 0, to: doc.length }]);
      for (const range of ranges) {
        if (range.kind !== "hide") continue;
        const pattern = Object.entries(syntax).find(([name]) => name === range.syntax)?.[1];
        expect(pattern?.test(doc.slice(range.from, range.to))).toBe(true);
      }
    }
  }
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
