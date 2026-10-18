import { expect, test } from "bun:test";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { editorLanguage } from "./editor-language";

test("wiki tokens do not accumulate CommonMark link delimiters in a long paragraph", () => {
  // Given
  const doc = Array.from({ length: 5000 }, (_, i) => `문장 ${i + 1} 한글 English [[연결]]`).join("\n");
  const before = EditorState.create({ doc, extensions: [editorLanguage()] });
  // When
  const after = before.update({ changes: { from: doc.length, insert: "한" } }).state;
  const tree = ensureSyntaxTree(after, after.doc.length, 1000);
  const nodes: string[] = [];
  tree?.iterate({ enter(node) { if (node.name === "WikiLink" || node.name === "Link") nodes.push(node.name); } });
  // Then
  expect(nodes).toEqual(Array.from({ length: 5000 }, () => "WikiLink"));
  expect(after.doc.toString()).toBe(doc + "한");
});

test("keeps GFM, ordinary links, escaped brackets and code independent of wiki tokens", () => {
  // Given
  const doc = "[[문서#제목|표시]] [일반](https://example.com) ~~취소~~ `[[코드]]` \\[[이스케이프]]\n\n~~~\n[[펜스]]\n~~~";
  const state = EditorState.create({ doc, extensions: [editorLanguage()] });
  // When
  const tree = ensureSyntaxTree(state, doc.length, 1000);
  const wiki: string[] = [];
  const types: string[] = [];
  tree?.iterate({ enter(node) {
    types.push(node.name);
    if (node.name === "WikiLink") wiki.push(doc.slice(node.from, node.to));
  } });
  // Then
  expect(wiki).toEqual(["[[문서#제목|표시]]"]);
  expect(types).toContain("Link");
  expect(types).toContain("Strikethrough");
  expect(types).toContain("InlineCode");
  expect(types).toContain("FencedCode");
});
