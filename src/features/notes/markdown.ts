import { parseWikiLinks } from "@/lib/wikilinks";

/** Do not glue an inserted link to an existing line-start heading, list, quote or fence. */
export function attachmentMarkdownAt(document: string, position: number, markdown: string): string {
  const startsLine = position === 0 || document[position - 1] === "\n";
  return startsLine && position < document.length ? `${markdown}\n\n` : markdown;
}

/** Convert only parsed wikilinks (code is excluded by the parser) into safe local Markdown links. */
export function expandWikiLinks(markdown: string): string {
  const links = parseWikiLinks(markdown);
  if (links.length === 0) return markdown;
  let output = "";
  let cursor = 0;
  for (const link of links) {
    output += markdown.slice(cursor, link.start);
    const label = escapeLabel(link.label ?? link.target);
    output += `[${label}](/notes/by-title?title=${encodeURIComponent(link.target)})`;
    cursor = link.end;
  }
  return output + markdown.slice(cursor);
}

function escapeLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1");
}

export function wikiTitleFromHref(href: string): string | null {
  if (!href.startsWith("/notes/by-title?")) return null;
  return new URL(href, "https://aro.invalid").searchParams.get("title");
}
