import { describe, expect, test } from "bun:test";
import {
  attachmentHref, createNameAllocator, frontMatter, noteMarkdown, rewriteAttachmentLinks, safeAttachmentName,
  safeFileName, createPortableLinkResolver, rewritePortableWikiLinks, type ExportNote,
} from "./export-format";

const note: ExportNote = {
  id: "6f1c2a0e-6c7b-4c55-9d0e-1c7a3b9e2f10",
  title: "회의: \"Q3\" #plan \\ 끝",
  aliases: ["별칭 - 하나", "multi\nline\u2028sep", "del\u007fchar"],
  tags: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-30T12:34:56.789Z",
  dailyDate: "2026-09-30",
  sourceUrl: null,
  pinned: true,
  archived: false,
  body: "---\n본문 [[위키 링크|표시]]\n",
};

describe("safeFileName", () => {
  test("replaces characters that are unsafe on Windows, macOS or Linux and keeps Korean text", () => {
    expect(safeFileName("회의록: A/B <테스트>?*|\"\\ 끝", "untitled")).toBe("회의록- A-B -테스트------ 끝");
    expect(safeFileName("tab\tand\nnewline\u0000", "untitled")).toBe("tab-and-newline-");
  });

  test("drops leading and trailing dots and spaces, and falls back when nothing is left", () => {
    expect(safeFileName("  ..hidden. . ", "untitled")).toBe("hidden");
    expect(safeFileName(" ... ", "untitled")).toBe("untitled");
  });

  test("normalizes to NFC and suffixes Windows device names", () => {
    expect(safeFileName("\u1112\u1161\u11ab", "untitled")).toBe("한");
    expect(safeFileName("CON", "untitled")).toBe("CON_");
    expect(safeFileName("lpt1.notes", "untitled")).toBe("lpt1_.notes");
    expect(safeFileName("console", "untitled")).toBe("console");
  });

  test("truncates to 150 UTF-8 bytes without splitting a character or emoji", () => {
    const name = safeFileName("가".repeat(80), "untitled");
    expect(name).toBe("가".repeat(50));
    const emoji = safeFileName(`${"a".repeat(145)}👩‍👩‍👧`, "untitled");
    expect(emoji).toBe("a".repeat(145));
  });
});

describe("portable wiki links", () => {
  const resolve = createPortableLinkResolver([
    { id: "old", title: "A/B", aliases: ["Alias", "exact"], path: "notes/A-B.md" },
    { id: "duplicate", title: "a/b", aliases: ["Alias"], path: "notes/a-b-2.md" },
    { id: "exact", title: "exact", aliases: [], path: "notes/exact.md" },
    { id: "long", title: "가".repeat(80), aliases: [], path: `notes/${"가".repeat(50)}.md` },
    { id: "extension", title: "a.md", aliases: [], path: "notes/a.md.md" },
  ]);

  test("uses title precedence, whitespace normalization and first non-self duplicate", () => {
    expect(resolve("  ALIAS  ", "source")).toBe("A-B.md");
    expect(resolve("EXACT", "source")).toBe("exact.md");
    expect(resolve("a/b", "old")).toBe("a-b-2.md");
    expect(resolve("exact", "exact")).toBe("A-B.md");
    expect(resolve("missing", "source")).toBeUndefined();
  });

  test("keeps headings, original display spelling, explicit labels and unresolved tokens", () => {
    expect(rewritePortableWikiLinks(
      "[[ALIAS#Part One|shown]] [[A/B]] [[missing#h|x]]", "source", resolve,
    )).toBe("[[A-B.md#Part One|shown]] [[A-B.md|A/B]] [[missing#h|x]]");
    expect(rewritePortableWikiLinks(`[[${"가".repeat(80)}]]`, "source", resolve))
      .toBe(`[[${"가".repeat(50)}.md|${"가".repeat(80)}]]`);
  });

  test("excludes inline, variable backtick, fenced, tilde, indented and escaped code", () => {
    const body = [
      "`[[Alias]]`", "``a ` [[Alias]]``", "```md", "[[Alias]]", "```",
      "~~~md", "[[Alias]]", "~~~", "    [[Alias]]", "\\[[Alias]]", "[[Alias]]",
    ].join("\n");
    expect(rewritePortableWikiLinks(body, "source", resolve)).toBe(
      body.slice(0, body.lastIndexOf("[[Alias]]")) + "[[A-B.md|Alias]]",
    );
  });

  test("default note Markdown retains wiki links even when allocated names differ", () => {
    const body = "[[Alias#heading|label]] [[A/B]]";
    expect(noteMarkdown({ ...note, body }, new Map()).slice(frontMatter(note).length)).toBe(body);
  });

  test("distinguishes code and live links inside Markdown containers", () => {
    for (const body of [
      "> ~~~md\n> [[Alias]]\n> ~~~",
      ">     [[Alias]]",
      "- ~~~md\n  [[Alias]]\n  ~~~",
      "> - ~~~md\n>   [[Alias]]\n>   ~~~",
      "- item\n\n      [[Alias]]",
      "[[Alias`example`]]",
    ]) expect(rewritePortableWikiLinks(body, "source", resolve)).toBe(body);
    for (const body of [
      "- item\n\n    [[Alias]]",
      "> [[Alias]]",
      "- [[Alias]]",
      "\\` [[Alias]] \\`",
      "\\\\[[Alias]]",
    ]) expect(rewritePortableWikiLinks(body, "source", resolve))
      .toBe(body.replace("[[Alias]]", "[[A-B.md|Alias]]"));
  });

  test("handles longer closing fences, embedded fences and multiline code spans", () => {
    const body = [
      "````md", "```", "[[Alias]]", "`````", "~~~", "[[Alias]]", "~~~~",
      "``inline", "[[Alias]]", "end``", "[[Alias]]",
    ].join("\n");
    expect(rewritePortableWikiLinks(body, "source", resolve)).toBe(
      body.slice(0, body.lastIndexOf("[[Alias]]")) + "[[A-B.md|Alias]]",
    );
  });

  test("uses the full filename when the original title already ends in .md", () => {
    expect(rewritePortableWikiLinks("[[a.md#heading]]", "source", resolve))
      .toBe("[[a.md.md#heading|a.md]]");
  });
});

describe("safeAttachmentName", () => {
  test("keeps a short extension in lowercase and sanitizes the stem", () => {
    expect(safeAttachmentName("다이어그램 v2.final.PNG")).toEqual({ stem: "다이어그램 v2.final", extension: ".png" });
    expect(safeAttachmentName("no-extension")).toEqual({ stem: "no-extension", extension: "" });
    expect(safeAttachmentName(".png")).toEqual({ stem: "attachment", extension: ".png" });
  });
});

describe("createNameAllocator", () => {
  test("suffixes collisions -2, -3 and treats names differing only in case as the same", () => {
    const allocate = createNameAllocator();
    expect(["Note", "note", "NOTE", "Note-2", "회의"].map((stem) => allocate(stem, ".md")))
      .toEqual(["Note.md", "note-2.md", "NOTE-3.md", "Note-2-2.md", "회의.md"]);
  });
});

describe("frontMatter", () => {
  test("round-trips titles, aliases and dates through a YAML parser", () => {
    const text = frontMatter(note);
    const yaml = text.slice(4, text.indexOf("\n---\n"));
    expect(Bun.YAML.parse(yaml)).toEqual({
      id: note.id,
      title: note.title,
      aliases: [...note.aliases],
      tags: [],
      created: note.createdAt,
      updated: note.updatedAt,
      daily_date: "2026-09-30",
      source_url: null,
      pinned: true,
      archived: false,
    });
  });

  test("keeps the body verbatim after the closing delimiter", () => {
    const markdown = noteMarkdown(note, new Map());
    expect(markdown.startsWith("---\n")).toBe(true);
    expect(markdown.slice(frontMatter(note).length)).toBe(note.body);
  });
});

describe("attachment links", () => {
  const id = "0b7e5f3c-2d1a-4e8b-9c6f-5a4d3e2f1b0c";
  const hrefs = new Map([[id, attachmentHref("회의 사진 (1).png")]]);

  test("escapes characters that would end a Markdown link destination", () => {
    expect(attachmentHref("회의 사진 (1)#2.png")).toBe("../attachments/회의%20사진%20%281%29%232.png");
  });

  test("rewrites images, links, reference definitions and HTML attributes for exported ids", () => {
    const body = [
      `![사진](/api/attachments/${id})`,
      `[file](/api/attachments/${id.toUpperCase()} "title")`,
      `[ref]: /api/attachments/${id}`,
      `<img src="/api/attachments/${id}">`,
    ].join("\n");
    const href = "../attachments/회의%20사진%20%281%29.png";
    expect(rewriteAttachmentLinks(body, hrefs)).toBe([
      `![사진](${href})`, `[file](${href} "title")`, `[ref]: ${href}`, `<img src="${href}">`,
    ].join("\n"));
  });

  test("leaves unknown ids, prose mentions and longer paths untouched", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    const body = `[x](/api/attachments/${other}) see /api/attachments/${id} [y](/api/attachments/${id}-extra)`;
    expect(rewriteAttachmentLinks(body, hrefs)).toBe(body);
  });
});
