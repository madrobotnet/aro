import { stripInboxUrlStatus } from "@/lib/inbox-url-status";
import { htmlText } from "@/lib/html-text";
import type { InboxItem } from "@/lib/types";

/** Compare before truncation: the first-line capture title may cover the whole body. */
export function inboxPreview(item: Pick<InboxItem, "title" | "body"> & Partial<Pick<InboxItem, "url">>, limit = 140): string {
  const body = stripInboxUrlStatus(item.body);
  // Only link excerpts are interpreted as captured HTML. Editors and stored bodies stay literal.
  // Old regex extraction sometimes left an attribute's closing quote and angle bracket behind.
  const text = (item.url ? htmlText(body.replace(/(^|\s)["']+>["']?/g, "$1")) : body).replace(/\s+/g, " ").trim();
  if (text === item.title.replace(/\s+/g, " ").trim()) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
