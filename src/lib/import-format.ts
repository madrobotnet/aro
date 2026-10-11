import { crc32, inflateRawSync } from "node:zlib";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";
import { ApiError } from "@/server/http";

export const IMPORT_LIMITS = {
  // Raw uploads stay below the existing 26 MiB proxy body boundary.
  uploadBytes: 24 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  entryBytes: 25 * 1024 * 1024,
  entries: 1000,
  notes: 500,
} as const;

// Mutable note metadata is part of the import API's editing contract.
export type ImportNote = { readonly path: string; title: string; body: string; aliases: string[]; tags: string[]; exportId?: string };
export type ImportAttachment = { readonly path: string; bytes: Uint8Array };
export type ImportWarning = { readonly path: string; code: string; detail: string };
export type ParsedImport = {
  readonly notes: readonly ImportNote[];
  readonly attachments: readonly ImportAttachment[];
  readonly warnings: readonly ImportWarning[];
};

function invalid(detail: string): never { throw new ApiError("validation", detail); }
function limit(detail: string): never { throw new ApiError("payload_too_large", detail); }
function warn(warnings: ImportWarning[], path: string, code: string, detail: string): void {
  if (!warnings.some((w) => w.path === path && w.code === code && w.detail === detail)) {
    warnings.push({ path, code, detail });
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const markdownExtension = /\.(?:md|markdown)$/i;
const noteSchema = z.object({
  title: z.string().min(1).max(300).refine((value) => value.trim().length > 0 && !value.includes("\0")),
  body: z.string().max(2_000_000).refine((value) => !value.includes("\0")),
  aliases: z.array(z.string().min(1).max(300).refine((value) => !value.includes("\0"))).max(100),
  tags: z.array(z.string().min(1).max(100).refine((value) => !value.includes("\0"))).max(100),
});
function text(bytes: Uint8Array): string {
  try { return utf8.decode(bytes); }
  catch (error) {
    if (error instanceof TypeError) invalid("Import text must be valid UTF-8.");
    throw error;
  }
}

function safePath(raw: string, directory = false): string {
  const path = raw.normalize("NFC");
  const parts = (directory ? path.slice(0, -1) : path).split("/");
  if (!path || /[\\:\p{Cc}]/u.test(path) || path.startsWith("/") ||
      parts.some((part) => !part || part === "." || part === "..")) invalid(`Unsafe import path: ${raw}`);
  return path;
}

type ZipEntry = {
  readonly path: string; readonly directory: boolean; readonly method: number;
  readonly crc: number; readonly size: number; readonly compressed: number;
  readonly local: number; readonly flags: number;
};

/** Validate the complete directory and every local record before inflating any entry. */
function zipFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bounds = (start: number, size: number, end = bytes.length): void => {
    if (start < 0 || size < 0 || start + size > end) invalid("ZIP record is out of bounds.");
  };
  const u16 = (at: number): number => { bounds(at, 2); return view.getUint16(at, true); };
  const u32 = (at: number): number => { bounds(at, 4); return view.getUint32(at, true); };
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) invalid("ZIP end record is missing.");
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) invalid("Multipart ZIP is unsupported.");
  const count = u16(end + 10), centralSize = u32(end + 12), central = u32(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || central === 0xffffffff ||
      (end >= 20 && u32(end - 20) === 0x07064b50)) invalid("ZIP64 is unsupported.");
  if (count > IMPORT_LIMITS.entries) limit("Too many ZIP entries.");
  if (central + centralSize !== end) invalid("ZIP central directory bounds are inconsistent.");
  bounds(central, centralSize, end);
  const extra = (start: number, length: number): void => {
    const stop = start + length;
    bounds(start, length);
    while (start < stop) {
      bounds(start, 4, stop);
      const kind = u16(start), size = u16(start + 2);
      if (kind === 1) invalid("ZIP64 is unsupported.");
      // Alternate names can disagree with the validated header name.
      if (kind === 0x7075) {
        bounds(start + 4, size, stop);
        if (size < 5 || bytes[start + 4] !== 1) invalid("Invalid ZIP Unicode path field.");
      }
      bounds(start + 4, size, stop);
      start += 4 + size;
    }
  };
  const entries: ZipEntry[] = [], paths = new Set<string>();
  let cursor = central, expanded = 0, noteCount = 0;
  for (let i = 0; i < count; i++) {
    bounds(cursor, 46, end);
    if (u32(cursor) !== 0x02014b50) invalid("Invalid ZIP central record.");
    const flags = u16(cursor + 8), method = u16(cursor + 10);
    if ((flags & ~0x808) !== 0 || (method !== 0 && method !== 8)) invalid("Encrypted or unsupported ZIP compression.");
    if (u16(cursor + 34) !== 0 || u16(cursor + 6) > 20) invalid("Unsupported ZIP version or disk.");
    const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32);
    bounds(cursor + 46, nameLength + extraLength + commentLength, end);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    if (!(flags & 0x800) && nameBytes.some((b) => b > 127)) invalid("Non-UTF-8 ZIP names are unsupported.");
    const raw = text(nameBytes), directory = raw.endsWith("/");
    const path = safePath(raw, directory), key = path.replace(/\/$/, "").toLowerCase();
    if (paths.has(key)) invalid(`Duplicate ZIP path: ${path}`);
    paths.add(key);
    const attributes = u32(cursor + 38), kind = (attributes >>> 16) & 0xf000;
    if ((kind !== 0 && kind !== (directory ? 0x4000 : 0x8000)) ||
        (attributes & 8) || ((attributes & 16) !== 0 && !directory)) invalid("ZIP symlinks and special entries are unsupported.");
    const size = u32(cursor + 24), compressed = u32(cursor + 20), local = u32(cursor + 42);
    if ([size, compressed, local].includes(0xffffffff)) invalid("ZIP64 is unsupported.");
    if (size > IMPORT_LIMITS.entryBytes) limit(`ZIP entry is too large: ${path}`);
    expanded += size;
    if (expanded > IMPORT_LIMITS.expandedBytes) limit("Expanded ZIP is too large.");
    if (markdownExtension.test(path) && ++noteCount > IMPORT_LIMITS.notes) limit("Too many notes.");
    if (directory && (size || compressed)) invalid("ZIP directory contains data.");
    extra(cursor + 46 + nameLength, extraLength);
    entries.push({ path, directory, method, size, compressed, local, flags, crc: u32(cursor + 16) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) invalid("ZIP entry count is inconsistent.");
  const ranges: Array<{ readonly entry: ZipEntry; readonly start: number; readonly end: number }> = [];
  for (const entry of entries) {
    const at = entry.local;
    bounds(at, 30, central);
    if (u32(at) !== 0x04034b50 || u16(at + 4) > 20 ||
        u16(at + 6) !== entry.flags || u16(at + 8) !== entry.method) invalid("ZIP local header disagrees with directory.");
    const nameLength = u16(at + 26), extraLength = u16(at + 28), start = at + 30 + nameLength + extraLength;
    bounds(at + 30, nameLength + extraLength, central);
    if (text(bytes.subarray(at + 30, at + 30 + nameLength)).normalize("NFC") !== entry.path) invalid("ZIP local path disagrees with directory.");
    extra(at + 30 + nameLength, extraLength);
    bounds(start, entry.compressed, central);
    let stop = start + entry.compressed;
    if (entry.flags & 8) {
      // Streaming export uses a data descriptor; zero or matching local sizes are legal.
      for (const [offset, value] of [[14, entry.crc], [18, entry.compressed], [22, entry.size]]) {
        if (offset === undefined || value === undefined) invalid("Invalid ZIP size.");
        if (u32(at + offset) !== 0 && u32(at + offset) !== value) invalid("ZIP local sizes disagree.");
      }
      if (u32(stop) === 0x08074b50) stop += 4;
      bounds(stop, 12, central);
      if (u32(stop) !== entry.crc || u32(stop + 4) !== entry.compressed || u32(stop + 8) !== entry.size) invalid("ZIP descriptor disagrees with directory.");
      stop += 12;
    } else if (u32(at + 14) !== entry.crc || u32(at + 18) !== entry.compressed || u32(at + 22) !== entry.size) {
      invalid("ZIP local sizes disagree with directory.");
    }
    ranges.push({ entry, start, end: stop });
  }
  let localEnd = 0;
  for (const range of [...ranges].sort((a, b) => a.entry.local - b.entry.local)) {
    if (range.entry.local !== localEnd) invalid("ZIP has overlapping, hidden or unsupported local records.");
    localEnd = range.end;
  }
  if (localEnd !== central) invalid("ZIP has unlisted local records.");
  const files = new Map<string, Uint8Array>();
  for (const { entry, start } of ranges) {
    if (entry.directory) continue;
    const compressed = bytes.subarray(start, start + entry.compressed);
    let output: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressed !== entry.size) invalid("Stored ZIP size is inconsistent.");
      output = compressed.slice();
    } else {
      try {
        // Node's declarations omit the info:true return variant; narrow its runtime shape.
        const raw: unknown = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size), info: true });
        const result = z.object({
          buffer: z.instanceof(Uint8Array), engine: z.object({ bytesWritten: z.number() }),
        }).parse(raw);
        if (result.engine.bytesWritten !== compressed.length) invalid("ZIP deflate contains trailing data.");
        output = result.buffer;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof Error) {
          if ("code" in error && error.code === "ERR_BUFFER_TOO_LARGE") limit(`ZIP expansion exceeds declared size: ${entry.path}`);
          invalid(`Invalid ZIP deflate data: ${entry.path}`);
        }
        throw error;
      }
    }
    if (output.length !== entry.size || crc32(output) !== entry.crc) invalid("ZIP expanded size or checksum is inconsistent.");
    files.set(entry.path, output);
  }
  return files;
}

/** Supported YAML: flat scalars, flat flow arrays and indented scalar lists.
 * Complex YAML stays verbatim in the body rather than depending on Bun-only YAML.
 */
function scalar(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") invalid("Invalid frontmatter string.");
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) invalid("Malformed frontmatter quoted string.");
      throw error;
    }
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) invalid("Malformed frontmatter quoted string.");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (!value || /^[&*!|>{[\]}]/.test(value) || /:\s/.test(value)) return undefined;
  return value.replace(/\s+#.*$/, "");
}

function flowList(raw: string): string[] | undefined {
  const values: string[] = [];
  let start = raw.indexOf("[") + 1, quote = "", nested = 0, supported = true;
  for (let at = start; at < raw.length; at++) {
    const char = raw[at];
    if (quote) {
      if (quote === '"' && char === "\\") { at++; continue; }
      if (quote === "'" && char === "'" && raw[at + 1] === "'") { at++; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if ((char === '"' || char === "'") && !raw.slice(start, at).trim()) { quote = char; continue; }
    if (char === "[" || char === "{") { nested++; supported = false; }
    if ((char === "]" || char === "}") && nested > 0) { nested--; continue; }
    if (nested) continue;
    if (char === "," || char === "]") {
      const item = raw.slice(start, at).trim();
      if (item) {
        const value = scalar(item);
        if (value === undefined) supported = false;
        else values.push(value);
      } else if (char === ",") invalid("Empty frontmatter flow-list item.");
      start = at + 1;
      if (char === "]") {
        if (!/^\s*(?:#.*)?$/.test(raw.slice(start))) invalid("Malformed frontmatter flow list.");
        return supported ? values : undefined;
      }
    }
  }
  invalid("Unclosed frontmatter flow list.");
}

function markdown(path: string, bytes: Uint8Array, warnings: ImportWarning[]): ImportNote {
  const source = text(bytes).replace(/^\ufeff/, "");
  if (source.includes("\0")) invalid(`NUL is not supported in note text: ${path}`);
  const note: ImportNote = { path, title: path.split("/").at(-1)?.replace(markdownExtension, "") ?? path, body: source, aliases: [], tags: [] };
  if (!/^---\r?\n/.test(source)) return note;
  const opening = source.indexOf("\n") + 1;
  const closing = /^---[ \t]*\r?$/gm;
  closing.lastIndex = opening;
  const end = closing.exec(source);
  if (!end) invalid(`Unclosed frontmatter: ${path}`);
  const lines = source.slice(opening, end.index).split(/\r?\n/);
  const seen = new Set<string>();
  let preserve = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const field = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (!field || !field[1]) {
      preserve = true;
      warn(warnings, path, "unsupported_metadata", "Complex YAML is retained in the body.");
      continue;
    }
    const key = field[1], raw = field[2] ?? "";
    if (seen.has(key)) invalid(`Duplicate frontmatter field: ${key}`);
    seen.add(key);
    if (!["title", "aliases", "tags"].includes(key)) {
      preserve = true;
      warn(warnings, path, "unsupported_metadata", `Frontmatter field retained, not imported: ${key}`);
      continue;
    }
    if (key === "title") {
      const value = scalar(raw);
      if (value === undefined) {
        preserve = true;
        warn(warnings, path, "unsupported_metadata", "Unsupported title YAML is retained in the body.");
      } else note.title = value;
    } else {
      const values: string[] = [];
      let supported = true;
      if (raw.trim().startsWith("[")) {
        const result = flowList(raw);
        if (result === undefined) supported = false;
        else values.push(...result);
      } else if (!raw.trim()) {
        while (i + 1 < lines.length && /^[ \t]+-/.test(lines[i + 1] ?? "")) {
          const item = (lines[++i] ?? "").replace(/^[ \t]+-[ \t]*/, "");
          const value = scalar(item);
          if (value === undefined) supported = false;
          else values.push(value);
        }
      } else {
        const value = scalar(raw);
        if (value === undefined) supported = false;
        else values.push(value);
      }
      if (!supported) {
        preserve = true;
        warn(warnings, path, "unsupported_metadata", `Unsupported ${key} YAML is retained in the body.`);
      } else if (key === "aliases") note.aliases = values;
      else note.tags = values;
    }
  }
  if (!preserve) note.body = source.slice(end.index + end[0].length).replace(/^\r?\n/, "");
  return note;
}

const manifestSchema = z.object({
  version: z.literal(1),
  wikiLinks: z.enum(["preserve", "portable"]).optional(),
  notes: z.array(z.object({ id: z.string(), path: z.string(), title: z.string(), aliases: z.array(z.string()) })),
  attachments: z.array(z.object({ id: z.string(), path: z.string() })),
  omittedAttachments: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export function parseImport(filename: string, bytes: Uint8Array): ParsedImport {
  if (bytes.length > IMPORT_LIMITS.uploadBytes) limit("Import upload is too large.");
  const warnings: ImportWarning[] = [], notes: ImportNote[] = [], attachments: ImportAttachment[] = [];
  let files: Map<string, Uint8Array>;
  if (markdownExtension.test(filename)) {
    if (bytes.length > IMPORT_LIMITS.entryBytes) limit("Markdown entry is too large.");
    files = new Map([[safePath(filename), bytes]]);
  } else if (/\.zip$/i.test(filename)) files = zipFiles(bytes);
  else invalid("Only Markdown (.md, .markdown) and ZIP imports are supported.");
  for (const [path, contents] of files) {
    if (markdownExtension.test(path)) notes.push(markdown(path, contents, warnings));
    else if (path !== "export-manifest.json") attachments.push({ path, bytes: contents.slice() });
  }
  const manifest = files.get("export-manifest.json");
  if (manifest) {
    let raw: unknown;
    try { raw = JSON.parse(text(manifest)); }
    catch (error) {
      if (error instanceof SyntaxError) invalid("Malformed export manifest.");
      throw error;
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) invalid("Unsupported or malformed export manifest; only v1 is supported.");
    const receipt = parsed.data, mapped = new Set<string>();
    for (const record of [...receipt.notes, ...receipt.attachments]) {
      safePath(record.path);
      if (mapped.has(record.path)) invalid("Duplicate export manifest path.");
      mapped.add(record.path);
      if (!files.has(record.path)) warn(warnings, record.path, "missing_manifest_entry", "Export manifest entry is absent from the archive.");
    }
    for (const record of receipt.notes) {
      const note = notes.find((item) => item.path === record.path);
      if (note) {
        note.title = record.title;
        note.aliases = [...record.aliases];
        note.exportId = record.id;
      }
    }
    for (const omission of receipt.omittedAttachments) {
      warn(warnings, "export-manifest.json", "omitted_attachment", `${omission.id}: ${omission.reason}`);
    }
    if (receipt.notes.length || receipt.attachments.length) {
      warn(warnings, "export-manifest.json", "metadata_not_imported", "Export IDs and full-state metadata are not restored.");
    }
    if (typeof raw === "object" && raw !== null) {
      for (const key of Object.keys(raw)) {
        if (!["version", "wikiLinks", "notes", "attachments", "omittedAttachments"].includes(key)) {
          warn(warnings, "export-manifest.json", "unsupported_metadata", `Unsupported manifest field: ${key}`);
        }
      }
    }
  }
  for (const note of notes) {
    if (!noteSchema.safeParse(note).success) invalid(`Note metadata or body exceeds supported limits: ${note.path}`);
  }
  return { notes, attachments, warnings };
}

function localPath(source: string, target: string): string | undefined {
  if (!target || target.startsWith("#") || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(target.replace(/\\([\\()[\]<> ])/g, "$1")); }
  catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
  if (decoded.startsWith("/") || decoded.includes("\\") || /[\p{Cc}]/u.test(decoded)) return undefined;
  const parts = source.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (part === "..") { if (!parts.length) return undefined; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/").normalize("NFC");
}

/** Source-position edits retain original Markdown spelling, labels and code. */
export function rewriteImportBody(
  note: ImportNote, notes: readonly ImportNote[], attachmentUrls: ReadonlyMap<string, string>, warnings: ImportWarning[],
  noteIds?: ReadonlyMap<string, string>,
): string {
  const body = note.body, nodes: Nodes[] = [fromMarkdown(body)];
  const excluded: Array<readonly [number, number]> = [];
  const imageReferences = new Set<string>();
  const html: Array<{ readonly start: number; readonly value: string }> = [];
  const links: Array<{ readonly start: number; readonly end: number; readonly url: string; readonly definition: boolean; readonly image: boolean; readonly identifier: string | undefined }> = [];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node) break;
    if (node.type === "imageReference") imageReferences.add(node.identifier);
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === "code" || node.type === "inlineCode" || node.type === "html") {
        excluded.push([start, end]);
        if (node.type === "html") html.push({ start, value: node.value });
      }
      else if (node.type === "link" || node.type === "image" || node.type === "definition") {
        links.push({ start, end, url: node.url, definition: node.type === "definition",
          image: node.type === "image", identifier: node.type === "definition" ? node.identifier : undefined });
      }
    }
    if ("children" in node) nodes.push(...node.children);
  }
  if (/^---\r?\n/.test(body)) {
    const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(body.slice(4));
    if (close) excluded.push([0, 4 + close.index + close[0].length]);
  }
  const escaped = (at: number): boolean => {
    let before = at;
    while (body[before - 1] === "\\") before--;
    return (at - before) % 2 === 1;
  };
  const blocked = (start: number, end: number): boolean => excluded.some(([a, b]) => a < end && b > start);
  const edits: Array<{ readonly start: number; readonly end: number; readonly value: string }> = [];
  const findNotes = (target: string): readonly ImportNote[] => {
    const internal = /^\/notes\/([0-9a-f-]{36})$/i.exec(target);
    if (internal) return notes.filter((n) => n.exportId?.toLowerCase() === internal[1]?.toLowerCase());
    const path = localPath(note.path, target);
    const candidates = notes.filter((n) => n.path === path || n.path === `${path}.md` || n.path === `${path}.markdown` ||
      n.path === target || n.path === `${target}.md` || n.path === `${target}.markdown`);
    if (candidates.length > 0) return candidates;
    const byName = notes.filter((n) => n.title === target || n.aliases.includes(target) ||
      n.path.split("/").at(-1)?.replace(markdownExtension, "") === target.replace(markdownExtension, ""));
    return byName;
  };
  const findNote = (target: string): ImportNote | undefined => {
    const candidates = findNotes(target);
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const attachment = (target: string): string | undefined => {
    if (!target || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(target)) return undefined;
    const path = localPath(note.path, target);
    let url = path === undefined ? undefined : attachmentUrls.get(path) ?? attachmentUrls.get(target);
    if (url === undefined && path !== undefined && !target.includes("/")) {
      const matches = [...attachmentUrls].filter(([key]) => key.split("/").at(-1) === path.split("/").at(-1));
      if (matches.length === 1) url = matches[0]?.[1];
    }
    if (url === undefined && !findNote(target)) warn(warnings, note.path, "missing_attachment", `Local attachment not found: ${target}`);
    return url;
  };
  const href = (url: string): string => url.replace(/[\s()<>"\\]/g, (char) => encodeURIComponent(char));
  for (const fragment of html) {
    // Rewrite standalone resource tags, never strings inside HTML script/code blocks.
    const standalone = /^<(?:img|a|audio|video|source)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>\s*$/i.test(fragment.value);
    for (const attribute of fragment.value.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
      const target = attribute[2];
      if (!target || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(target)) continue;
      if (!standalone || target.includes("&")) {
        warn(warnings, note.path, "unsupported_html", "Local HTML resource references are retained; convert this HTML block to Markdown to reconnect its attachments.");
        continue;
      }
      if (findNotes(target).length > 0 || markdownExtension.test(target.split("#")[0] ?? "")) {
        warn(warnings, note.path, "unsupported_note_link", `Local HTML note link is retained: ${target}`);
        continue;
      }
      const url = attachment(target);
      if (url === undefined) continue;
      const valueStart = attribute.index + attribute[0].indexOf(attribute[1] ?? '"') + 1;
      edits.push({ start: fragment.start + valueStart, end: fragment.start + valueStart + target.length, value: href(url) });
    }
  }
  for (const link of links.sort((a, b) => a.start - b.start)) {
    // Code inside a label is display content, not a literal enclosing the link.
    if (excluded.some(([a, b]) => a <= link.start && b >= link.end) ||
        (body[link.start - 1] === "!" && escaped(link.start - 1))) continue;
    const token = body.slice(link.start, link.end);
    let at = 0;
    if (link.definition) {
      const prefix = /^[ \t]{0,3}\[[^\n]+?\]:\s*/.exec(token);
      if (!prefix) continue;
      at = prefix[0].length;
    } else {
      let depth = 0;
      for (; at < token.length; at++) {
        if (token[at] === "\\") { at++; continue; }
        if (token[at] === "[") depth++;
        if (token[at] === "]" && --depth === 0) { at++; break; }
      }
      if (token[at] !== "(") continue;
      at++;
      while (/\s/.test(token[at] ?? "") && at < token.length) at++;
    }
    const angle = token[at] === "<";
    if (angle) at++;
    const start = at;
    let depth = 0;
    for (; at < token.length; at++) {
      const char = token[at];
      if (char === "\\") { at++; continue; }
      if (angle ? char === ">" : (/\s/.test(char ?? "") || (char === ")" && depth === 0))) break;
      if (char === "(") depth++;
      if (char === ")") depth--;
    }
    const hash = link.url.indexOf("#");
    const target = hash < 0 ? link.url : link.url.slice(0, hash);
    if (!target || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) continue;
    const query = target.indexOf("?");
    const noteTarget = query < 0 ? target : target.slice(0, query);
    const internalNote = /^\/notes\/[0-9a-f-]{36}$/i.test(noteTarget);
    const candidates = findNotes(noteTarget);
    if (candidates.length > 0 || markdownExtension.test(noteTarget) || internalNote) {
      const fragment = hash < 0 ? "" : link.url.slice(hash);
      if (link.image || (link.identifier !== undefined && imageReferences.has(link.identifier)) ||
          query >= 0 || (!internalNote && localPath(note.path, target) === undefined) || fragment.startsWith("#^")) {
        warn(warnings, note.path, "unsupported_note_link", `Local Markdown note link is retained: ${link.url}`);
      } else if (candidates.length !== 1) {
        warn(warnings, note.path, candidates.length > 1 ? "ambiguous_note_link" : "missing_note",
          `Local Markdown note target ${candidates.length > 1 ? "is ambiguous" : "was not found"}: ${target}`);
      } else {
        warn(warnings, note.path, "markdown_note_graph_unsupported",
          "Local Markdown note links preserve navigation but do not create graph or backlink connections.");
        if (fragment) warn(warnings, note.path, "unsupported_note_fragment",
          "Note fragments are retained, but Markdown heading scrolling is not supported.");
        const resolved = candidates[0];
        const id = resolved === undefined ? undefined : noteIds?.get(resolved.path);
        if (id !== undefined) edits.push({ start: link.start + start, end: link.start + at, value: href(`/notes/${id}${fragment}`) });
      }
      continue;
    }
    const url = attachment(target);
    if (url !== undefined) edits.push({ start: link.start + start, end: link.start + at, value: href(url) + (hash < 0 ? "" : link.url.slice(hash)) });
  }
  for (const match of body.matchAll(/(!?)\[\[([^\[\]\n|#]+)(#[^\[\]\n|]+)?(\|[^\[\]\n]+)?\]\]/g)) {
    const start = match.index, end = start + match[0].length, target = match[2]?.trim();
    if (!target || escaped(start) || (match[1] === "!" && escaped(start + 1)) || blocked(start, end) ||
        links.some((link) => link.start < end && link.end > start)) continue;
    if (match[1] === "!") {
      const url = attachment(target);
      if (url !== undefined) {
        const label = (match[4]?.slice(1) ?? target).replace(/[\\[\]]/g, "\\$&");
        edits.push({ start, end, value: `![${label}](${href(url)}${match[3] ?? ""})` });
      }
    } else {
      const resolved = findNote(target);
      if (resolved) edits.push({ start, end, value: `[[${resolved.title}${match[3] ?? ""}${match[4] ?? ""}]]` });
      else if (/\.[^/.]+$/.test(target)) {
        const url = attachment(target);
        if (url !== undefined) {
          const label = (match[4]?.slice(1) ?? target).replace(/[\\[\]]/g, "\\$&");
          edits.push({ start, end, value: `[${label}](${href(url)}${match[3] ?? ""})` });
        }
      }
    }
  }
  let result = "", cursor = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (edit.start < cursor) continue;
    result += body.slice(cursor, edit.start) + edit.value;
    cursor = edit.end;
  }
  result += body.slice(cursor);
  if (!noteSchema.shape.body.safeParse(result).success) invalid(`Rewritten note body exceeds supported limits: ${note.path}`);
  return result;
}
