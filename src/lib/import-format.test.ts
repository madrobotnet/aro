import { describe, expect, test } from "bun:test";
import { crc32, deflateRawSync } from "node:zlib";
import { Zip, ZipDeflate, zipSync } from "fflate";
import { ApiError } from "@/server/http";
import { frontMatter, noteMarkdown, type ExportNote } from "./export-format";
import { IMPORT_LIMITS, parseImport, rewriteImportBody, type ImportNote, type ImportWarning } from "./import-format";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const date = new Date("2026-01-01T00:00:00Z");
type Fixture = {
  path: string; body?: Uint8Array; method?: number; flags?: number;
  mode?: number; size?: number; checksum?: number; localPath?: string;
};

/** Independent binary fixtures also represent archives a normal ZIP writer refuses to produce. */
function archive(entries: readonly Fixture[]): Uint8Array {
  const local: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encode(entry.path), localName = encode(entry.localPath ?? entry.path);
    const body = entry.body ?? encode("body"), method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(body) : body;
    const size = entry.size ?? body.length, checksum = entry.checksum ?? crc32(body);
    const header = new Uint8Array(30 + localName.length + compressed.length);
    const l = new DataView(header.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true);
    l.setUint16(6, entry.flags ?? 0x800, true); l.setUint16(8, method, true);
    l.setUint32(14, checksum, true); l.setUint32(18, compressed.length, true); l.setUint32(22, size, true);
    l.setUint16(26, localName.length, true); header.set(localName, 30); header.set(compressed, 30 + localName.length);
    local.push(header);
    const record = new Uint8Array(46 + name.length), c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x314, true); c.setUint16(6, 20, true);
    c.setUint16(8, entry.flags ?? 0x800, true); c.setUint16(10, method, true);
    c.setUint32(16, checksum, true); c.setUint32(20, compressed.length, true); c.setUint32(24, size, true);
    c.setUint16(28, name.length, true); c.setUint32(38, (entry.mode ?? 0x81a4) * 65536, true);
    c.setUint32(42, offset, true); record.set(name, 46); central.push(record);
    offset += header.length;
  }
  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  const bytes = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const record of [...local, ...central]) { bytes.set(record, at); at += record.length; }
  const e = new DataView(bytes.buffer, at);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
  return bytes;
}

function failure(filename: string, bytes: Uint8Array): string {
  try { parseImport(filename, bytes); }
  catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  return "accepted";
}

const exported: ExportNote = {
  id: "old-id", title: 'Title "quote" \\ unicode \u2028',
  aliases: ["line\nbreak", "del\u007f", "alias"], tags: ["one", "two"],
  createdAt: date.toISOString(), updatedAt: date.toISOString(),
  dailyDate: null, sourceUrl: null, pinned: false, archived: true,
  body: "Body [[Other#part|label]]\n",
};
const makeNote = (path: string, title: string, body = ""): ImportNote => ({ path, title, body, aliases: [], tags: [] });

describe("Markdown imports", () => {
  test("roundtrips export quoted fields while retaining non-imported metadata", () => {
    // Given
    const bytes = encode(noteMarkdown(exported, new Map()));
    // When
    const result = parseImport("note.md", bytes);
    // Then
    expect(result.notes[0]).toEqual({
      path: "note.md", title: exported.title, aliases: [...exported.aliases], tags: [...exported.tags],
      body: frontMatter(exported) + exported.body,
    });
    expect(result.warnings.map((w) => w.code)).toEqual(Array(7).fill("unsupported_metadata"));
  });

  test("extracts supported subset fields and preserves aliases and tags", () => {
    // Given
    const source = "---\r\ntitle: 'It''s a title'\r\naliases:\r\n  - \"a\"\r\n  - plain\r\ntags: [\"tag\"]\r\n---\r\nbody";
    // When
    const result = parseImport("folder/note.md", encode(source));
    // Then
    expect(result.notes).toEqual([{ path: "folder/note.md", title: "It's a title", aliases: ["a", "plain"], tags: ["tag"], body: "body" }]);
    expect(result.warnings).toEqual([]);
  });

  for (const metadata of ["custom: {nested: value}", "tags: [work, {nested: value}]", "aliases: &anchor [a]", "title: |"]) {
    test(`retains unsupported YAML when given ${metadata}`, () => {
      // Given
      const source = `---\n${metadata}\n---\nbody`;
      // When
      const result = parseImport("note.md", encode(source));
      // Then
      expect(result.notes[0]?.body).toBe(source);
      expect(result.warnings[0]?.code).toBe("unsupported_metadata");
    });
  }

  for (const source of ['---\ntitle: "unterminated\n---\nbody', "---\ntitle: 'unterminated\n---\nbody", "---\ntitle: one\ntitle: two\n---\n", "---\ntags: []\n"]) {
    test(`rejects malformed or duplicate YAML ${JSON.stringify(source)}`, () => {
      // Given / When
      const code = failure("note.md", encode(source));
      // Then
      expect(code).toBe("validation");
    });
  }

  test("rejects malformed UTF-8 rather than silently replacing bytes", () => {
    // Given / When
    const code = failure("note.md", new Uint8Array([0xc0, 0xaf]));
    // Then
    expect(code).toBe("validation");
  });

  test("uses filename title without treating body headings as metadata", () => {
    // Given / When
    const result = parseImport("folder/name.MD", encode("# Heading\nBody"));
    // Then
    expect(result.notes[0]?.title).toBe("name");
    expect(result.notes[0]?.body).toBe("# Heading\nBody");
  });

  test("imports Obsidian unquoted flow lists with quoted commas and escaped quotes", () => {
    // Given
    const source = `---\ntitle: First\naliases: [Beginning, "a,b", 'It''s me', "quote\\"here"]\ntags: [work, "a # b", 'single,comma'] # comment\n---\nbody`;
    // When
    const result = parseImport("First.markdown", encode(source));
    // Then
    expect(result.notes[0]).toEqual({
      path: "First.markdown", title: "First", body: "body",
      aliases: ["Beginning", "a,b", "It's me", 'quote"here'], tags: ["work", "a # b", "single,comma"],
    });
    expect(result.warnings).toEqual([]);
  });

  for (const list of ['["unterminated]', "[a,,b]", "[a", "[a] garbage"]) {
    test(`rejects malformed flat flow list ${list}`, () => {
      // Given / When
      const code = failure("a.md", encode(`---\naliases: ${list}\n---\nbody`));
      // Then
      expect(code).toBe("validation");
    });
  }

  for (const [field, value] of [
    ["title", '""'], ["title", '"   "'], ["title", JSON.stringify("x".repeat(301))],
    ["title", '"nul\\u0000"'], ["aliases", '[""]'], ["tags", '[""]'],
    ["aliases", JSON.stringify(["x".repeat(301)])], ["tags", JSON.stringify(["x".repeat(101)])],
    ["aliases", JSON.stringify(Array(101).fill("alias"))], ["tags", JSON.stringify(Array(101).fill("tag"))],
    ["aliases", '["nul\\u0000"]'], ["tags", '["nul\\u0000"]'],
  ]) {
    test(`rejects invalid note API field ${field} ${value?.slice(0, 30)}`, () => {
      // Given / When
      const code = failure("a.md", encode(`---\n${field}: ${value}\n---\nbody`));
      // Then
      expect(code).toBe("validation");
    });
  }
  for (const body of ["raw\0body", "x".repeat(2_000_001)]) {
    test(`rejects invalid note body of length ${body.length}`, () => {
      // Given / When
      const code = failure("a.md", encode(body));
      // Then
      expect(code).toBe("validation");
    });
  }
  test("accepts metadata and body at existing note API limits", () => {
    // Given
    const source = `---\ntitle: ${"t".repeat(300)}\naliases: ${JSON.stringify(Array(100).fill("a".repeat(300)))}\ntags: ${JSON.stringify(Array(100).fill("t".repeat(100)))}\n---\n${"b".repeat(2_000_000)}`;
    // When
    const result = parseImport("a.markdown", encode(source));
    // Then
    expect(result.notes[0]?.body.length).toBe(2_000_000);
    expect(result.notes[0]?.aliases).toHaveLength(100);
    expect(result.notes[0]?.tags).toHaveLength(100);
  });
});

describe("ZIP imports", () => {
  test("imports real fflate deflated Markdown and stored attachments", () => {
    // Given
    const zip = zipSync({ "notes/a.md": encode("note"), "attachments/a.png": [new Uint8Array([1, 2, 3]), { level: 0 }] });
    // When
    const result = parseImport("archive.zip", zip);
    // Then
    expect(result.notes[0]?.body).toBe("note");
    expect(result.attachments).toEqual([{ path: "attachments/a.png", bytes: new Uint8Array([1, 2, 3]) }]);
  });

  test("imports streaming data descriptors used by the export service", () => {
    // Given
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, bytes) => { if (error) throw error; chunks.push(bytes); });
    const entry = new ZipDeflate("notes/a.md", { level: 6 });
    entry.mtime = date; zip.add(entry); entry.push(encode("streamed"), true); zip.end();
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    // When
    const result = parseImport("archive.zip", bytes);
    // Then
    expect(result.notes[0]?.body).toBe("streamed");
  });

  test("respects v1 note mappings and reports omitted attachments without migrating state", () => {
    // Given
    const manifest = {
      version: 1, wikiLinks: "portable",
      notes: [{ id: "old", title: "Canonical", aliases: ["Alias"], path: "notes/safe.md" }],
      attachments: [{ id: "attachment", path: "attachments/missing.png" }],
      omittedAttachments: [{ id: "lost", reason: "file_missing" }],
    };
    const zip = archive([{ path: "notes/safe.md" }, { path: "export-manifest.json", body: encode(JSON.stringify(manifest)) }]);
    // When
    const result = parseImport("archive.zip", zip);
    // Then
    expect(result.notes[0]?.title).toBe("Canonical");
    expect(result.notes[0]?.aliases).toEqual(["Alias"]);
    expect(result.attachments).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(["missing_manifest_entry", "omitted_attachment", "metadata_not_imported"]);
  });

  for (const version of [2, "1"]) {
    test(`rejects unsupported manifest version ${version}`, () => {
      // Given
      const zip = archive([{ path: "export-manifest.json", body: encode(JSON.stringify({ version })) }]);
      // When
      const code = failure("a.zip", zip);
      // Then
      expect(code).toBe("validation");
    });
  }

  for (const path of ["../a.md", "folder/../../a.md", "/a.md", "C:/a.md", "folder\\a.md", "a//b.md", "./a.md", "a\u0000.md"]) {
    test(`rejects unsafe archive path ${JSON.stringify(path)}`, () => {
      // Given / When
      const code = failure("a.zip", archive([{ path }]));
      // Then
      expect(code).toBe("validation");
    });
  }
  for (const mode of [0xa1ff, 0x11a4, 0x21a4, 0x61a4, 0xc1a4, 0x41ed]) {
    test(`rejects symlink or special entry mode ${mode.toString(16)}`, () => {
      // Given / When
      const code = failure("a.zip", archive([{ path: "a.md", mode }]));
      // Then
      expect(code).toBe("validation");
    });
  }
  for (const flags of [1, 0x40, 0x2000]) {
    test(`rejects encryption or unsupported flags ${flags}`, () => {
      // Given / When
      const code = failure("a.zip", archive([{ path: "a.md", flags }]));
      // Then
      expect(code).toBe("validation");
    });
  }
  test("rejects unsupported compression methods", () => {
    // Given / When
    const code = failure("a.zip", archive([{ path: "a.md", method: 99 }]));
    // Then
    expect(code).toBe("validation");
  });
  for (const pair of [["a.md", "a.md"], ["a.md", "A.md"], ["é.md", "e\u0301.md"]]) {
    test(`rejects duplicate normalized paths ${pair.join(",")}`, () => {
      // Given / When
      const code = failure("a.zip", archive(pair.map((path) => ({ path }))));
      // Then
      expect(code).toBe("validation");
    });
  }
  test("rejects local name disagreement before decompression", () => {
    // Given / When
    const code = failure("a.zip", archive([{ path: "safe.md", localPath: "../a.md", method: 8 }]));
    // Then
    expect(code).toBe("validation");
  });
  test("rejects wrong checksums", () => {
    // Given / When
    const code = failure("a.zip", archive([{ path: "a.md", checksum: 123 }]));
    // Then
    expect(code).toBe("validation");
  });
  for (const mutation of ["multipart", "zip64", "central-bounds", "local-size", "overlap", "truncated"] as const) {
    test(`rejects ${mutation} archive records`, () => {
      // Given
      let bytes = archive([{ path: "a.md" }, { path: "b.md" }]);
      const view = new DataView(bytes.buffer), end = bytes.length - 22, central = view.getUint32(end + 16, true);
      switch (mutation) {
        case "multipart": view.setUint16(end + 4, 1, true); break;
        case "zip64": view.setUint16(end + 10, 0xffff, true); view.setUint16(end + 8, 0xffff, true); break;
        case "central-bounds": view.setUint32(end + 16, 0xfffffff0, true); break;
        case "local-size": view.setUint32(22, 123, true); break;
        case "overlap": view.setUint32(central + 50 + 42, 0, true); break;
        case "truncated": bytes = bytes.subarray(0, bytes.length - 1); break;
      }
      // When
      const code = failure("a.zip", bytes);
      // Then
      expect(code).toBe("validation");
    });
  }
  test("bounds actual deflate output when advertised size conceals a bomb", () => {
    // Given
    const zip = archive([{ path: "a.md", body: new Uint8Array(1024 * 1024), method: 8, size: 1 }]);
    // When
    const code = failure("a.zip", zip);
    // Then
    expect(code).toBe("payload_too_large");
  });
  test("rejects advertised entry size before allocating output", () => {
    // Given
    const zip = archive([{ path: "a.md", method: 8, size: IMPORT_LIMITS.entryBytes + 1 }]);
    // When
    const code = failure("a.zip", zip);
    // Then
    expect(code).toBe("payload_too_large");
  });
  test("rejects aggregate expanded size before allocating output", () => {
    // Given
    const zip = archive(["a.png", "b.png", "c.png"].map((path) => ({ path, method: 8, size: IMPORT_LIMITS.entryBytes })));
    // When
    const code = failure("a.zip", zip);
    // Then
    expect(code).toBe("payload_too_large");
  });
  test("rejects excessive entry count", () => {
    // Given
    const zip = archive(Array.from({ length: IMPORT_LIMITS.entries + 1 }, (_, i) => ({ path: `${i}.png` })));
    // When
    const code = failure("a.zip", zip);
    // Then
    expect(code).toBe("payload_too_large");
  });
  test("rejects excessive note count", () => {
    // Given
    const zip = archive(Array.from({ length: IMPORT_LIMITS.notes + 1 }, (_, i) => ({ path: `${i}.md` })));
    // When
    const code = failure("a.zip", zip);
    // Then
    expect(code).toBe("payload_too_large");
  });
  test("counts .markdown files as notes rather than attachments", () => {
    // Given
    const zip = archive(Array.from({ length: IMPORT_LIMITS.notes + 1 }, (_, i) => ({ path: `${i}.markdown` })));
    // When
    const code = failure("a.zip", zip);
    // Then
    expect(code).toBe("payload_too_large");
  });
  test("rejects invalid note metadata supplied by a v1 manifest", () => {
    // Given
    const zip = archive([
      { path: "a.md" },
      { path: "export-manifest.json", body: encode(JSON.stringify({
        version: 1, notes: [{ id: "old", path: "a.md", title: "", aliases: [] }],
        attachments: [], omittedAttachments: [],
      })) },
    ]);
    // When
    const code = failure("a.zip", zip);
    // Then
    expect(code).toBe("validation");
  });
  test("rejects oversized uploads under the existing proxy boundary", () => {
    // Given / When
    const code = failure("a.zip", new Uint8Array(IMPORT_LIMITS.uploadBytes + 1));
    // Then
    expect(IMPORT_LIMITS.uploadBytes).toBe(24 * 1024 * 1024);
    expect(code).toBe("payload_too_large");
  });
  test("rejects unsupported upload kinds", () => {
    // Given / When
    const code = failure("a.tar", encode("text"));
    // Then
    expect(code).toBe("validation");
  });
});

describe("import link rewriting", () => {
  const other = { ...makeNote("notes/safe.md", "Canonical"), aliases: ["Alias"] };
  const urls = new Map([["attachments/photo (1).png", "/api/attachments/uuid"], ["notes/file.pdf", "/api/attachments/pdf"]]);
  test("rewrites local Markdown note destinations without changing rich labels titles or references", () => {
    // Given
    const note = makeNote("notes/source.md", "Source", [
      '[Read **target** `code` \\[label\\]](safe.md#section "title")',
      "[reference][target]", "", "[target]: <safe.md> 'reference title'",
      "[encoded](../notes/safe%2Emd)",
      "`[literal](safe.md)`",
    ].join("\n"));
    const warnings: ImportWarning[] = [];
    // When
    const body = rewriteImportBody(note, [note, other], urls, warnings,
      new Map([[other.path, "00000000-0000-4000-8000-000000000001"]]));
    // Then
    expect(body).toBe([
      '[Read **target** `code` \\[label\\]](/notes/00000000-0000-4000-8000-000000000001#section "title")',
      "[reference][target]", "", "[target]: </notes/00000000-0000-4000-8000-000000000001> 'reference title'",
      "[encoded](/notes/00000000-0000-4000-8000-000000000001)",
      "`[literal](safe.md)`",
    ].join("\n"));
    expect(warnings.map(({ code }) => code)).toEqual(["markdown_note_graph_unsupported", "unsupported_note_fragment"]);
  });
  test("warns about ambiguous missing and unsupported Markdown note links", () => {
    // Given
    const note = makeNote("source.md", "Source", [
      "[ambiguous](same.md)", "[missing](missing.md)", "[query](safe.md?view=1)",
      "[block](safe.md#^block)", "![embed](safe.md)", "[unsafe](/safe.md)",
      "![reference][note]", "", "[note]: safe.md",
    ].join("\n"));
    const warnings: ImportWarning[] = [];
    // When
    const body = rewriteImportBody(note, [
      note, makeNote("a/same.md", "One"), makeNote("b/same.md", "Two"), makeNote("safe.md", "Safe"),
    ], urls, warnings);
    // Then
    expect(body).toBe(note.body);
    expect(warnings.map(({ code }) => code)).toEqual([
      "ambiguous_note_link", "missing_note", "unsupported_note_link",
      "unsupported_note_link", "unsupported_note_link", "unsupported_note_link",
    ]);
  });
  test("resolves relative wiki filenames with and without extensions and retains labels and headings", () => {
    // Given
    const note = makeNote("notes/source.md", "Source", "[[safe#Heading|Label]] [[safe.md]] [[notes/safe.md]] [[Alias]]");
    const warnings: ImportWarning[] = [];
    // When
    const body = rewriteImportBody(note, [note, other], urls, warnings);
    // Then
    expect(body).toBe("[[Canonical#Heading|Label]] [[Canonical]] [[Canonical]] [[Canonical]]");
    expect(warnings).toEqual([]);
  });
  test("rewrites Markdown images links references and Obsidian attachments without changing labels or titles", () => {
    // Given
    const note = makeNote("notes/source.md", "Source", [
      '![Photo](../attachments/photo%20%281%29.png "title")',
      "[PDF](file.pdf)", "", "[ref]: <../attachments/photo%20%281%29.png> 'title'",
      "![ref][ref]", "![[../attachments/photo (1).png|Photo]]",
    ].join("\n"));
    const warnings: ImportWarning[] = [];
    // When
    const body = rewriteImportBody(note, [note], urls, warnings);
    // Then
    expect(body).toBe([
      '![Photo](/api/attachments/uuid "title")',
      "[PDF](/api/attachments/pdf)", "", "[ref]: </api/attachments/uuid> 'title'",
      "![ref][ref]", "![Photo](/api/attachments/uuid)",
    ].join("\n"));
    expect(warnings).toEqual([]);
  });
  test("preserves fenced indented inline and escaped literals including Markdown containers", () => {
    // Given
    const body = [
      "`[[safe]] ![x](file.pdf)`", "``[[safe]] ` ![[file.pdf]]``",
      "~~~md", "[[safe]] ![x](file.pdf)", "~~~", "    [[safe]] ![x](file.pdf)",
      "> ```", "> [[safe]] ![[file.pdf]]", "> ```",
      "- ~~~", "  [[safe]]", "  ~~~",
      "\\[[safe]] \\![x](file.pdf) \\![[file.pdf]]", "[[safe]]",
    ].join("\n");
    const note = makeNote("notes/source.md", "Source", body), warnings: ImportWarning[] = [];
    // When
    const result = rewriteImportBody(note, [note, other], urls, warnings);
    // Then
    expect(result).toBe(body.slice(0, body.lastIndexOf("[[safe]]")) + "[[Canonical]]");
    expect(warnings).toEqual([]);
  });
  test("reports missing local attachments deterministically and leaves remote URLs untouched", () => {
    // Given
    const note = makeNote("notes/source.md", "Source", [
      "![x](missing.png)", "[x](missing.png)", "![[missing.png]]",
      "![remote](https://example.test/photo.png)", "[email](mailto:a@example.test)",
      "![remote](//example.test/photo.png)", "[section](#heading)",
    ].join("\n"));
    const warnings: ImportWarning[] = [];
    // When
    const body = rewriteImportBody(note, [note], urls, warnings);
    // Then
    expect(body).toBe(note.body);
    expect(warnings).toEqual([{ path: note.path, code: "missing_attachment", detail: "Local attachment not found: missing.png" }]);
  });
  test("leaves ambiguous wiki names unchanged", () => {
    // Given
    const note = makeNote("source.md", "Source", "[[same]]"), warnings: ImportWarning[] = [];
    // When
    const body = rewriteImportBody(note, [note, makeNote("a/same.md", "One"), makeNote("b/same.md", "Two")], urls, warnings);
    // Then
    expect(body).toBe(note.body);
  });
  test("preserves unsupported frontmatter and does not rewrite its literals", () => {
    // Given
    const note = makeNote("notes/source.md", "Source", "---\ncustom: '[[safe]]'\n---\n[[safe]]");
    const warnings: ImportWarning[] = [];
    // When
    const body = rewriteImportBody(note, [note, other], urls, warnings);
    // Then
    expect(body).toBe("---\ncustom: '[[safe]]'\n---\n[[Canonical]]");
  });
  test("resolves .markdown paths and stems to canonical titles", () => {
    // Given
    const note = makeNote("notes/source.markdown", "Source", "[[other]] [[other.markdown#part|label]]");
    const target = makeNote("notes/other.markdown", "Canonical"), warnings: ImportWarning[] = [];
    // When
    const body = rewriteImportBody(note, [note, target], urls, warnings);
    // Then
    expect(body).toBe("[[Canonical]] [[Canonical#part|label]]");
  });
  test("resolves Obsidian attachment basenames only when unambiguous", () => {
    // Given
    const note = makeNote("notes/source.md", "Source", "![[photo (1).png]]"), warnings: ImportWarning[] = [];
    // When
    const body = rewriteImportBody(note, [note], urls, warnings);
    // Then
    expect(body).toBe("![photo (1).png](/api/attachments/uuid)");
    expect(warnings).toEqual([]);
  });
  test("rewrites linked wiki attachments and standalone HTML resource tags without touching code", () => {
    const note = makeNote("notes/source.md", "Source", [
      "[[file.pdf|Document]]",
      '<img src="../attachments/photo%20%281%29.png" alt="photo">',
      "",
      'Inline <a href="file.pdf">PDF</a>',
      '`<img src="file.pdf">`',
    ].join("\n"));
    const warnings: ImportWarning[] = [];

    const body = rewriteImportBody(note, [note], urls, warnings);

    expect(body).toBe([
      "[Document](/api/attachments/pdf)",
      '<img src="/api/attachments/uuid" alt="photo">',
      "",
      'Inline <a href="/api/attachments/pdf">PDF</a>',
      '`<img src="file.pdf">`',
    ].join("\n"));
    expect(warnings).toEqual([]);
  });
  test("reports unsupported HTML blocks and missing wiki attachments without altering their contents", () => {
    const note = makeNote("notes/source.md", "Source", '<div><img src="file.pdf"></div>\n\n[[missing.pdf]]');
    const warnings: ImportWarning[] = [];

    const body = rewriteImportBody(note, [note], urls, warnings);

    expect(body).toBe(note.body);
    expect(warnings.map((warning) => warning.code)).toEqual(["unsupported_html", "missing_attachment"]);
  });
  test("preserves wiki-looking link labels while rewriting their destination", () => {
    // Given
    const note = makeNote("notes/source.md", "Source", "[[[safe]]](file.pdf)"), warnings: ImportWarning[] = [];
    // When
    const body = rewriteImportBody(note, [note, other], urls, warnings);
    // Then
    expect(body).toBe("[[[safe]]](/api/attachments/pdf)");
  });
  for (const uuid of ["preview-id", "commit-id"]) {
    test(`keeps missing warnings independent of ${uuid} attachment URLs`, () => {
      // Given
      const note = makeNote("notes/source.md", "Source", "[ok](file.pdf) ![missing](missing.png)");
      const warnings: ImportWarning[] = [];
      // When
      rewriteImportBody(note, [note], new Map([["notes/file.pdf", `/api/attachments/${uuid}`]]), warnings);
      // Then
      expect(warnings).toEqual([{ path: note.path, code: "missing_attachment", detail: "Local attachment not found: missing.png" }]);
    });
  }
});
