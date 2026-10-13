import { describe, expect, test } from "bun:test";
import { calendarDaysAgo, formatDate, formatDateTime, formatDayHeading, localDateKey } from "./format-date";
import { LOCALES } from "./locale";

const at = (iso: string) => Date.parse(iso);
const SEOUL = { timeZone: "Asia/Seoul" };
const INSTANT = "2026-09-29T10:18:45Z";

describe("formatDate", () => {
  test("ko is ISO-shaped and en is a short month date", () => {
    expect(formatDate(INSTANT, "ko", SEOUL)).toBe("2026-09-29");
    expect(formatDate(INSTANT, "en", SEOUL)).toBe("Sep 29, 2026");
  });

  test("accepts strings, epoch numbers and Date objects alike", () => {
    expect(formatDate(at(INSTANT), "ko", SEOUL)).toBe("2026-09-29");
    expect(formatDate(new Date(INSTANT), "en", SEOUL)).toBe("Sep 29, 2026");
  });

  test("uses the given zone, so one instant can fall on different dates", () => {
    // 01:30 on the 29th in Seoul is 09:30 on the 28th in Los Angeles.
    const instant = "2026-09-28T16:30:00.000Z";
    for (const locale of LOCALES) {
      expect(formatDate(instant, locale, SEOUL)).toContain("29");
      expect(formatDate(instant, locale, { timeZone: "America/Los_Angeles" })).toContain("28");
    }
    expect(formatDate(instant, "ko", SEOUL)).toBe("2026-09-29");
    expect(formatDate(instant, "ko", { timeZone: "America/Los_Angeles" })).toBe("2026-09-28");
  });
});

describe("formatDateTime", () => {
  test("shows hours and minutes without seconds", () => {
    expect(formatDateTime(INSTANT, "ko", SEOUL)).toBe("2026-09-29 오후 7:18");
    // Darwin ICU also uses " at "; Linux/Windows keep their existing assertion.
    const expected = process.platform === "darwin"
      ? /^Sep 29, 2026(?:,| at) 7:18\sPM$/ : /^Sep 29, 2026, 7:18\sPM$/;
    expect(formatDateTime(INSTANT, "en", SEOUL)).toMatch(expected);
  });

  test("no output contains a seconds field", () => {
    for (const locale of LOCALES) {
      for (const value of [INSTANT, "2026-01-05T23:59:59Z", "2026-12-31T00:00:01Z"]) {
        expect(formatDateTime(value, locale, SEOUL)).not.toMatch(/\d:\d{2}:\d{2}/);
        expect(formatDate(value, locale, SEOUL)).not.toMatch(/\d:\d{2}:\d{2}/);
      }
    }
  });
});

describe("invalid input", () => {
  test("returns an empty string instead of 'Invalid Date'", () => {
    for (const locale of LOCALES) {
      for (const value of ["", "not a date", Number.NaN, new Date(Number.NaN)]) {
        expect(formatDate(value, locale)).toBe("");
        expect(formatDateTime(value, locale)).toBe("");
      }
      expect(formatDayHeading("2026-9-29", locale)).toBe("");
    }
  });
});

describe("formatDayHeading", () => {
  test("names the weekday by default and reads the key as a calendar date", () => {
    expect(formatDayHeading("2026-09-29", "ko")).toBe("9월 29일 화요일");
    expect(formatDayHeading("2026-09-29", "en")).toBe("Tuesday, September 29");
  });

  test("can omit the weekday", () => {
    expect(formatDayHeading("2026-09-29", "ko", { weekday: false })).toBe("9월 29일");
    expect(formatDayHeading("2026-09-29", "en", { weekday: false })).toBe("September 29");
  });
});

describe("localDateKey", () => {
  test("is the calendar date in the given zone, not UTC", () => {
    expect(localDateKey(at("2026-09-28T15:30:00Z"), "Asia/Seoul")).toBe("2026-09-29");
    expect(localDateKey(at("2026-09-28T15:30:00Z"), "UTC")).toBe("2026-09-28");
  });

  test("defaults to now in the runtime zone", () => {
    expect(localDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("calendarDaysAgo", () => {
  test("counts calendar dates in the viewer's zone, not elapsed 24-hour periods", () => {
    // One hour apart: 23:30 and 00:30 in Seoul, the same afternoon or morning in UTC and Los Angeles.
    const edited = "2026-09-28T14:30:00.000Z";
    const now = at("2026-09-28T15:30:00.000Z");
    expect(calendarDaysAgo(edited, now, "Asia/Seoul")).toBe(1);
    expect(calendarDaysAgo(edited, now, "UTC")).toBe(0);
    expect(calendarDaysAgo(edited, now, "America/Los_Angeles")).toBe(0);
  });

  test("26 hours across two midnights is two days", () => {
    expect(calendarDaysAgo("2026-09-27T23:00:00.000Z", at("2026-09-29T01:00:00.000Z"), "UTC")).toBe(2);
  });

  test("the 23-hour day at a daylight-saving change still counts as one day", () => {
    // New York springs forward on 8 March 2026: noon to noon is 23 hours.
    expect(calendarDaysAgo("2026-03-07T17:00:00.000Z", at("2026-03-08T16:00:00.000Z"), "America/New_York")).toBe(1);
  });

  test("a timestamp ahead of the local clock is never counted as past", () => {
    expect(calendarDaysAgo("2026-09-29T12:00:00.000Z", at("2026-09-28T12:00:00.000Z"), "UTC")).toBeLessThanOrEqual(0);
  });
});
