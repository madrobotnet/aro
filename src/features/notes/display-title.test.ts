import { describe, expect, test } from "bun:test";
import { formatDayHeading } from "@/lib/i18n/format-date";
import { LOCALES } from "@/lib/i18n/locale";
import { DAILY_COPY } from "./daily-copy";
import { displayNoteTitle } from "./display-title";

describe("daily title display", () => {
  test("uses the shared day formatter and daily marker in both locales without mutating the title", () => {
    const note = { title: "2026-10-13", dailyDate: "2026-10-13" };
    const titles = LOCALES.map((locale) => displayNoteTitle(note, locale));
    expect(titles).toEqual(LOCALES.map((locale) => DAILY_COPY[locale].title(formatDayHeading(note.dailyDate, locale))));
    expect(titles.every((title) => title !== note.title)).toBe(true);
    expect(note.title).toBe("2026-10-13");
  });

  test("does not classify an ordinary ISO title as a daily note", () => {
    const note = { title: "2026-10-13", dailyDate: null };
    const titles = LOCALES.map((locale) => displayNoteTitle(note, locale));
    expect(titles).toEqual([note.title, note.title]);
  });

  test("preserves a daily note's owner supplied title", () => {
    const note = { title: "A day of reading", dailyDate: "2026-10-13" };
    const titles = LOCALES.map((locale) => displayNoteTitle(note, locale));
    expect(titles).toEqual([note.title, note.title]);
  });
});
