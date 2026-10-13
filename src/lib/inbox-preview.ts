import { stripInboxUrlStatus } from "./inbox-url-status";
import type { InboxItem } from "./types";

/** Compare before truncation: the first-line capture title may cover the whole body. */
export function inboxPreview(item: Pick<InboxItem, "title" | "body">, limit = 140): string {
  const text = stripInboxUrlStatus(item.body).replace(/\s+/g, " ").trim();
  if (text === item.title.replace(/\s+/g, " ").trim()) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
