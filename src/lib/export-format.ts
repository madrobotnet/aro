import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { normalizeTitle } from "./wikilinks";

export type ExportNote = {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly createdAt: string; // ISO
  readonly updatedAt: string; // ISO
  readonly dailyDate: string | null; // YYYY-MM-DD
  readonly sourceUrl: string | null;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly body: string;
};

export type ExportNoteFile = {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly path: string;
};

/** Input order is creation time, then ID. Titles beat aliases; the source is excluded like app links. */
export function createPortableLinkResolver(notes: readonly ExportNoteFile[]): (target: string, sourceId: string) => string | undefined {
  const titles = new Map<string, ExportNoteFile[]>();
  const aliases = new Map<string, ExportNoteFile[]>();
  for (const note of notes) {
    for (const [index, names] of [[titles, [note.title]], [aliases, note.aliases]] as const) {
      for (const name of names) {
        const key = normalizeTitle(name);
        const matches = index.get(key) ?? [];
        matches.push(note);
        index.set(key, matches);
      }
    }
  }
  return (target, sourceId) => {
    const key = normalizeTitle(target);
    const note = titles.get(key)?.find((note) => note.id !== sourceId)
      ?? aliases.get(key)?.find((note) => note.id !== sourceId);
    return note?.path.slice("notes/".length);
  };
}

/** Wiki-capable readers resolve the actual filename, not the original (possibly unsafe) title. */
export function rewritePortableWikiLinks(body: string, sourceId: string, resolve: (target: string, sourceId: string) => string | undefined): string {
  // CommonMark positions distinguish code from paragraphs inside lists and quotes.
  const nodes: Nodes[] = [fromMarkdown(body)];
  const excluded: Array<[number, number]> = [];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (!node) break;
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) excluded.push([start, end]);
    } else if ("children" in node) nodes.push(...node.children);
  }
  let masked = "";
  let cursor = 0;
  for (const [start, end] of excluded.sort((a, b) => a[0] - b[0])) {
    masked += body.slice(cursor, start) + " ".repeat(end - start);
    cursor = end;
  }
  masked += body.slice(cursor);
  let out = "";
  let last = 0;
  let codeIndex = 0;
  for (const match of masked.matchAll(/\[\[([^\[\]\n|#]+)(?:#([^\[\]\n|]+))?(?:\|([^\[\]\n]+))?\]\]/g)) {
    const start = match.index;
    const end = start + match[0].length;
    let code = excluded[codeIndex];
    while (code && code[1] <= start) code = excluded[++codeIndex];
    if (code && code[0] < end) continue;
    let escapeStart = start;
    while (body[escapeStart - 1] === "\\") escapeStart--;
    if ((start - escapeStart) % 2 === 1) continue;
    const target = match[1]?.trim();
    if (!target) continue;
    const filename = resolve(target, sourceId);
    if (filename === undefined) continue;
    const token = body.slice(start, end);
    const suffix = token.slice(2).search(/[|#\]]/);
    out += body.slice(last, start);
    out += `[[${filename}${token.slice(2 + suffix, -2)}${match[3] === undefined ? `|${target}` : ""}]]`;
    last = end;
  }
  return out + body.slice(last);
}

/** UTF-8 budget for one name before the collision suffix and extension (most file systems allow 255). */
const NAME_BYTES = 150;
// Reserved or unsafe on Windows, macOS or Linux, plus every control character.
const ILLEGAL = /[<>:"/\\|?*\p{Cc}]/gu;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const encoder = new TextEncoder();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const { segment } of graphemes.segment(value)) {
    bytes += encoder.encode(segment).length;
    if (bytes > maxBytes) break;
    result += segment;
  }
  return result;
}

/** A cross-platform file name stem (no extension) that keeps Korean and other Unicode text. */
export function safeFileName(raw: string, fallback: string): string {
  const cleaned = raw.normalize("NFC").replace(ILLEGAL, "-").replace(/\s+/g, " ").replace(/^[\s.]+/, "");
  const name = truncateUtf8(cleaned, NAME_BYTES).replace(/[\s.]+$/, "");
  if (!name) return fallback;
  return WINDOWS_DEVICE.test(name) ? name.replace(/^[^.]*/, (device) => `${device}_`) : name;
}

/** Split `photo.final.PNG` into a sanitized stem and a lowercase `.png` extension. */
export function safeAttachmentName(filename: string): { stem: string; extension: string } {
  const match = /^(.*?)(\.[A-Za-z0-9]{1,10})$/.exec(filename.normalize("NFC"));
  const stem = match ? match[1]! : filename;
  return { stem: safeFileName(stem, "attachment"), extension: match ? match[2]!.toLowerCase() : "" };
}

/**
 * Hand out unique names within one directory: `a.md`, `a-2.md`, `a-3.md`...
 * Comparison ignores case so the archive also unpacks on case-insensitive file systems.
 */
export function createNameAllocator(): (stem: string, extension: string) => string {
  const used = new Set<string>();
  return (stem, extension) => {
    for (let suffix = 1; ; suffix += 1) {
      const candidate = suffix === 1 ? `${stem}${extension}` : `${stem}-${suffix}${extension}`;
      const key = candidate.toLowerCase();
      if (!used.has(key)) {
        used.add(key);
        return candidate;
      }
    }
  };
}

/** Relative link from notes/ to attachments/<fileName>, escaping what would end a Markdown destination. */
export function attachmentHref(fileName: string): string {
  const escaped = fileName.replace(/[%\s()<>'"#[\]]/gu, (char) =>
    Array.from(encoder.encode(char), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""));
  return `../attachments/${escaped}`;
}

// Inline links/images, reference definitions and HTML src/href attributes that point at /api/attachments/<id>.
const ATTACHMENT_LINK =
  /(\]\(\s*<?|^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?|\b(?:src|href)=["'])\/api\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-z-])/gim;

/** Rewrite links to exported attachments; ids without an entry in `hrefs` keep their original link. */
export function rewriteAttachmentLinks(body: string, hrefs: ReadonlyMap<string, string>): string {
  return body.replace(ATTACHMENT_LINK, (match, prefix: string, id: string) => {
    const href = hrefs.get(id.toLowerCase());
    return href === undefined ? match : `${prefix}${href}`;
  });
}

/** A YAML double-quoted scalar; JSON escapes plus the characters YAML treats as breaks or non-printable. */
function quote(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
const list = (values: readonly string[]): string =>
  values.length === 0 ? " []" : values.map((value) => `\n  - ${quote(value)}`).join("");
const nullable = (value: string | null): string => (value === null ? "null" : quote(value));

export function frontMatter(note: ExportNote): string {
  return [
    "---",
    `id: ${quote(note.id)}`,
    `title: ${quote(note.title)}`,
    `aliases:${list(note.aliases)}`,
    `tags:${list(note.tags)}`,
    `created: ${quote(note.createdAt)}`,
    `updated: ${quote(note.updatedAt)}`,
    `daily_date: ${nullable(note.dailyDate)}`,
    `source_url: ${nullable(note.sourceUrl)}`,
    `pinned: ${note.pinned}`,
    `archived: ${note.archived}`,
    "---",
    "",
  ].join("\n");
}

/** Front matter and body; attachment links are rewritten, wiki links only with an explicit resolver. */
export function noteMarkdown(
  note: ExportNote,
  attachmentHrefs: ReadonlyMap<string, string>,
  resolve?: (target: string, sourceId: string) => string | undefined,
): string {
  const body = resolve ? rewritePortableWikiLinks(note.body, note.id, resolve) : note.body;
  return frontMatter(note) + rewriteAttachmentLinks(body, attachmentHrefs);
}
