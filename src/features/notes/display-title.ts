import { formatDayHeading } from "@/lib/i18n/format-date";
import type { Locale } from "@/lib/i18n/locale";
import type { NoteSummary } from "@/lib/types";
import { DAILY_COPY } from "./daily-copy";

/** Only a daily note's generated date title is display copy; custom titles remain user data. */
export function displayNoteTitle(note: Pick<NoteSummary, "title" | "dailyDate">, locale: Locale): string {
  return note.dailyDate && note.title === note.dailyDate
    ? DAILY_COPY[locale].title(formatDayHeading(note.dailyDate, locale))
    : note.title;
}
