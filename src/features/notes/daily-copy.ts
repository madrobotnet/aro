import { defineCopy } from "@/lib/i18n/copy";

const KO_WEEKDAYS = "일월화수목금토";
const KO_WEEKDAYS_LONG = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EN_WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Daily navigation (prev/next, mini calendar, `/daily?date=` launcher) copy.
 * `day` headings passed in come from `formatDayHeading`; weekday indexes are 0 = Sunday.
 */
export const DAILY_COPY = defineCopy({
  ko: {
    title: (day: string) => `${day} · 데일리 노트`,
    nav: {
      label: "데일리 노트 날짜 이동",
      previous: (day: string) => `전날 노트: ${day}`,
      next: (day: string) => `다음 날 노트: ${day}`,
      calendarHint: "달력 열기",
    },
    calendar: {
      label: "데일리 노트 날짜 선택",
      /** Month heading; `month` is 1-12. format-date.ts has no month-year formatter yet. */
      month: (year: number, month: number) => `${year}년 ${month}월`,
      previousMonth: "이전 달",
      nextMonth: "다음 달",
      weekday: (index: number) => KO_WEEKDAYS[index] ?? "",
      weekdayLong: (index: number) => KO_WEEKDAYS_LONG[index] ?? "",
      day: (day: string, hasNote: boolean, isToday: boolean) => `${day}${isToday ? ", 오늘" : ""}${hasNote ? ", 노트 있음" : ""}`,
      today: "오늘",
      legend: "노트 있음",
      loadFailed: "노트가 있는 날을 불러오지 못했어요",
      retry: "다시 시도",
    },
    launcher: {
      invalidDate: "날짜 형식이 올바르지 않아요. 날짜를 골라 다시 여세요.",
    },
  },
  en: {
    title: (day) => `${day} · Daily note`,
    nav: {
      label: "Daily note dates",
      previous: (day) => `Previous day: ${day}`,
      next: (day) => `Next day: ${day}`,
      calendarHint: "Open calendar",
    },
    calendar: {
      label: "Choose a daily note date",
      month: (year, month) => `${EN_MONTHS[month - 1] ?? ""} ${year}`,
      previousMonth: "Previous month",
      nextMonth: "Next month",
      weekday: (index) => EN_WEEKDAYS[index] ?? "",
      weekdayLong: (index) => EN_WEEKDAYS_LONG[index] ?? "",
      day: (day, hasNote, isToday) => `${day}${isToday ? ", today" : ""}${hasNote ? ", has a note" : ""}`,
      today: "Today",
      legend: "Has a note",
      loadFailed: "Couldn't load which days have notes",
      retry: "Try again",
    },
    launcher: {
      invalidDate: "That date isn't valid. Choose a date and open it again.",
    },
  },
});

export const PREVIEW_TASK_COPY = defineCopy({
  ko: {
    toggleFailed: "할 일을 바꾸지 못했어요.",
    conflict: {
      mismatch: "그사이 할 일이 바뀌었어요. 최신 노트를 불러온 뒤 다시 시도하세요.",
      trashed: "휴지통에 있는 노트라 할 일을 바꿀 수 없어요.",
      archived: "보관한 노트의 할 일은 바꿀 수 없어요.",
    },
  },
  en: {
    toggleFailed: "Couldn't update the task.",
    conflict: {
      mismatch: "This task changed in the meantime. Load the latest note and try again.",
      trashed: "This note is in the trash, so its tasks can't be changed.",
      archived: "Tasks in archived notes can't be changed.",
    },
  },
});
