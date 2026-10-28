import type { InboxItem, NoteTitleMatch } from "@/lib/types";
import { stripInboxUrlStatus } from "@/lib/inbox-url-status";

/** The block POST /api/inbox/:id/merge appends to the note: the stored text (or title), plus the URL when the text lacks it. */
export function mergeBlock(item: Pick<InboxItem, "title" | "body" | "url">): string {
  const text = stripInboxUrlStatus(item.body) || item.title;
  return item.url && !text.includes(item.url) ? `${text}\n\n${item.url}` : text;
}

export type MergeOption = { id: string; title: string; matchedAlias: string | null; suggested: boolean };

/**
 * Merge targets: with an empty query Jev's duplicate suggestion leads, followed by the
 * other titles; a typed query shows only the matches, still marking the suggestion.
 */
export function mergeOptions(
  results: readonly NoteTitleMatch[],
  suggestion: { noteId: string; title: string } | null,
  query: string,
): MergeOption[] {
  const options = results.map((note) => ({ id: note.id, title: note.title, matchedAlias: note.matchedAlias, suggested: note.id === suggestion?.noteId }));
  if (!suggestion || query.trim() !== "") return options;
  return [
    { id: suggestion.noteId, title: suggestion.title, matchedAlias: null, suggested: true },
    ...options.filter((option) => option.id !== suggestion.noteId),
  ];
}

