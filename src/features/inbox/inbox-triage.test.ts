import { describe, expect, test } from "bun:test";
import { copyParityIssues } from "@/lib/i18n/copy";
import { LOCALES } from "@/lib/i18n/locale";
import { URL_FAILED_MARKER, URL_PENDING_MARKER } from "@/lib/inbox-url-status";
import type { InboxItem } from "@/lib/types";
import { INBOX_COPY } from "./inbox-copy";
import {
  applyInboxChange,
  excerpt,
  formatCreated,
  insertInOrder,
  isSnoozed,
  kindLabel,
  mergeBlock,
  mergeOptions,
  mergeTags,
  moveSelection,
  neighbourAfterRemoval,
  parseSnoozeInput,
  replaceItem,
  resolveTriageKey,
  snoozeLimit,
  snoozePresets,
  snoozeRefreshDelay,
  stripUrlStatus,
  suggestionView,
  syncTriageDraft,
  toDateTimeLocalValue,
  urlStatus,
  withItem,
  withoutItem,
} from "./inbox-triage";

const key = (k: string, extra: Partial<Parameters<typeof resolveTriageKey>[0]> = {}) =>
  resolveTriageKey({ key: k, editable: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });

const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id,
  title: `제목 ${id}`,
  body: `본문 ${id}`,
  preview: `본문 ${id}`,
  homePreview: `본문 ${id}`,
  source: "web",
  url: null,
  createdAt: "2026-09-27T00:00:00.000Z",
  suggestions: null,
  snoozedUntil: null,
  ...over,
});

describe("resolveTriageKey", () => {
  test("maps vim and arrow keys to list movement and actions", () => {
    expect(key("j")).toBe("next");
    expect(key("ArrowDown")).toBe("next");
    expect(key("K")).toBe("prev");
    expect(key("Home")).toBe("first");
    expect(key("End")).toBe("last");
    expect(key("Enter")).toBe("open");
    expect(key("o")).toBe("open");
    expect(key("Escape")).toBe("clear");
    expect(key("x")).toBeNull();
  });

  test("maps Linear-style number keys and keeps the letter aliases", () => {
    expect(key("1")).toBe("promote");
    expect(key("p")).toBe("promote");
    expect(key("2")).toBe("discard");
    expect(key("d")).toBe("discard");
    expect(key("#", { shiftKey: true })).toBe("discard");
    expect(key("3")).toBe("merge");
    expect(key("h")).toBe("snooze");
    expect(key("H", { shiftKey: true })).toBe("snooze");
    expect(key("4")).toBeNull();
  });

  test("accepts digits typed with Shift, as some keyboard layouts require", () => {
    expect(key("1", { shiftKey: true })).toBe("promote");
    expect(key("2", { shiftKey: true })).toBe("discard");
    expect(key("3", { shiftKey: true })).toBe("merge");
  });

  test("never intercepts typing or modifier chords", () => {
    expect(key("j", { editable: true })).toBeNull();
    expect(key("Enter", { editable: true })).toBeNull();
    for (const k of ["1", "2", "3", "h"]) expect(key(k, { editable: true })).toBeNull();
    expect(key("p", { ctrlKey: true })).toBeNull();
    expect(key("k", { metaKey: true })).toBeNull();
    expect(key("d", { altKey: true })).toBeNull();
    expect(key("1", { metaKey: true })).toBeNull();
    expect(key("h", { ctrlKey: true })).toBeNull();
    expect(key("D", { shiftKey: true })).toBeNull();
    expect(key("P", { shiftKey: true })).toBeNull();
  });
});

describe("selection movement", () => {
  const items = [item("a"), item("b"), item("c")];

  test("moves within bounds and starts from the ends when nothing is selected", () => {
    expect(moveSelection(items, null, 1)).toBe("a");
    expect(moveSelection(items, null, -1)).toBe("c");
    expect(moveSelection(items, "a", 1)).toBe("b");
    expect(moveSelection(items, "c", 1)).toBe("c");
    expect(moveSelection(items, "a", -1)).toBe("a");
    expect(moveSelection(items, "b", 99)).toBe("c");
    expect(moveSelection([], "a", 1)).toBeNull();
  });

  test("picks the next neighbour after a removal, then the previous, then none", () => {
    expect(neighbourAfterRemoval(items, "a")).toBe("b");
    expect(neighbourAfterRemoval(items, "c")).toBe("b");
    expect(neighbourAfterRemoval([item("only")], "only")).toBeNull();
    expect(neighbourAfterRemoval(items, "zzz")).toBeNull();
  });
});

describe("cache helpers", () => {
  test("keep count in step with items and carry the Later count", () => {
    const data = { items: [item("a"), item("b")], count: 2, snoozedCount: 4, nextReturnAt: null };
    expect(withoutItem(data, "a")).toEqual({ items: [item("b")], count: 1, snoozedCount: 4, nextReturnAt: null });
    expect(withItem(data, item("c"))).toEqual({ items: [item("c"), item("a"), item("b")], count: 3, snoozedCount: 4, nextReturnAt: null });
    expect(withItem(data, item("a", { title: "새 제목" })).items.map((i) => i.title)).toEqual(["새 제목", "제목 b"]);
    expect(replaceItem(data, item("b", { title: "바뀜" })).items[1]?.title).toBe("바뀜");
    expect(withoutItem(undefined, "a")).toEqual({ items: [], count: 0, snoozedCount: 0, nextReturnAt: null });
    expect(withItem(undefined, item("a"))).toEqual({ items: [item("a")], count: 1, snoozedCount: 0, nextReturnAt: null });
  });
});

describe("list order and triage changes", () => {
  const newest = item("c", { createdAt: "2026-09-29T00:00:00.000Z" });
  const middle = item("b", { createdAt: "2026-09-28T00:00:00.000Z" });
  const oldest = item("a", { createdAt: "2026-09-27T00:00:00.000Z" });
  const open = { items: [newest, middle, oldest], count: 3, snoozedCount: 1, nextReturnAt: null };
  const later = (id: string, until: string) => item(id, { snoozedUntil: until });

  test("inserts where the server lists it: newest capture first, soonest return first, ties by id", () => {
    expect(insertInOrder([newest, oldest], middle, "open").map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(insertInOrder([middle, oldest], newest, "open").map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(insertInOrder([newest, middle], oldest, "open").map((i) => i.id)).toEqual(["c", "b", "a"]);
    const twin = item("z", { createdAt: middle.createdAt });
    expect(insertInOrder([newest, middle, oldest], twin, "open").map((i) => i.id)).toEqual(["c", "z", "b", "a"]);
    const soon = later("s", "2026-10-01T00:00:00.000Z");
    const far = later("f", "2026-11-01T00:00:00.000Z");
    expect(insertInOrder([far], soon, "later").map((i) => i.id)).toEqual(["s", "f"]);
    expect(insertInOrder([soon], far, "later").map((i) => i.id)).toEqual(["s", "f"]);
    expect(insertInOrder([soon, far], { ...soon, title: "새로" }, "later").map((i) => i.title)).toEqual(["새로", far.title]);
  });

  test("a discard and its undo return the item to its place", () => {
    const discarded = applyInboxChange("open", open, { type: "removed", id: "b" });
    expect(discarded).toEqual({ items: [newest, oldest], count: 2, snoozedCount: 1, nextReturnAt: null });
    expect(applyInboxChange("open", discarded, { type: "restored", item: middle })).toEqual(open);
    expect(applyInboxChange("open", open, { type: "restored", item: middle })).toEqual(open);
  });

  test("snoozing moves the item to Later and raises the badge once", () => {
    const snoozedItem = later("b", "2026-10-01T09:00:00.000Z");
    const afterOpen = applyInboxChange("open", open, { type: "snoozed", item: snoozedItem });
    expect(afterOpen).toEqual({ items: [newest, oldest], count: 2, snoozedCount: 2, nextReturnAt: snoozedItem.snoozedUntil });
    expect(applyInboxChange("open", afterOpen, { type: "snoozed", item: snoozedItem })).toEqual(afterOpen);

    const existing = later("x", "2026-12-01T09:00:00.000Z");
    const laterList = { items: [existing], count: 1, snoozedCount: 1, nextReturnAt: existing.snoozedUntil };
    const afterLater = applyInboxChange("later", laterList, { type: "snoozed", item: snoozedItem });
    expect(afterLater).toEqual({ items: [snoozedItem, existing], count: 2, snoozedCount: 2, nextReturnAt: snoozedItem.snoozedUntil });
    expect(applyInboxChange("later", afterLater, { type: "snoozed", item: snoozedItem })).toEqual(afterLater);
    const farther = later("f", "2027-01-01T09:00:00.000Z");
    expect(applyInboxChange("open", afterOpen, { type: "snoozed", item: farther }).nextReturnAt).toBe(snoozedItem.snoozedUntil);
  });

  test("unsnoozing brings the item back in order and lowers the badge once", () => {
    const returned = item("b", { createdAt: middle.createdAt });
    const withoutB = { items: [newest, oldest], count: 2, snoozedCount: 2, nextReturnAt: null };
    const afterOpen = applyInboxChange("open", withoutB, { type: "unsnoozed", item: returned });
    expect(afterOpen).toEqual({ items: [newest, returned, oldest], count: 3, snoozedCount: 1, nextReturnAt: null });
    expect(applyInboxChange("open", afterOpen, { type: "unsnoozed", item: returned })).toEqual(afterOpen);

    const laterList = { items: [later("b", "2026-10-01T09:00:00.000Z")], count: 1, snoozedCount: 1, nextReturnAt: null };
    const afterLater = applyInboxChange("later", laterList, { type: "unsnoozed", item: returned });
    expect(afterLater).toEqual({ items: [], count: 0, snoozedCount: 0, nextReturnAt: null });
    expect(applyInboxChange("later", afterLater, { type: "unsnoozed", item: returned })).toEqual(afterLater);
  });

  test("a missing cache starts empty and counts never go negative", () => {
    expect(applyInboxChange("open", undefined, { type: "unsnoozed", item: middle })).toEqual({ items: [middle], count: 1, snoozedCount: 0, nextReturnAt: null });
    expect(applyInboxChange("later", undefined, { type: "removed", id: "b" })).toEqual({ items: [], count: 0, snoozedCount: 0, nextReturnAt: null });
  });

  test("the return refresh waits for the soonest return, with slack, a floor and the timer limit", () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    expect(snoozeRefreshDelay(null, now)).toBeNull();
    expect(snoozeRefreshDelay("2026-09-30T12:10:00.000Z", now)).toBe(601_000);
    expect(snoozeRefreshDelay("2026-09-30T12:00:02.000Z", now)).toBe(5_000);
    expect(snoozeRefreshDelay("2026-09-30T11:59:00.000Z", now)).toBe(5_000);
    expect(snoozeRefreshDelay("2027-09-30T12:00:00.000Z", now)).toBe(2 ** 31 - 1);
  });

  test("isSnoozed compares against the injected clock", () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    expect(isSnoozed(item("a"), now)).toBe(false);
    expect(isSnoozed(item("a", { snoozedUntil: "2026-09-30T12:00:01.000Z" }), now)).toBe(true);
    expect(isSnoozed(item("a", { snoozedUntil: "2026-09-30T12:00:00.000Z" }), now)).toBe(false);
  });
});

describe("snooze presets", () => {
  // Local-time constructors keep these checks independent of the machine's time zone.
  const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);
  const summary = (now: Date) => snoozePresets(now).map(({ id, until }) => [id, toDateTimeLocalValue(until)]);

  test("offers this evening before 17:00, then tomorrow morning and next Monday", () => {
    // 2026-09-30 is a Wednesday.
    expect(summary(local(2026, 9, 30, 10, 15))).toEqual([
      ["evening", "2026-09-30T18:00"],
      ["tomorrow", "2026-10-01T09:00"],
      ["nextMonday", "2026-10-05T09:00"],
    ]);
    expect(summary(local(2026, 9, 30, 16, 59)).map(([id]) => id)).toEqual(["evening", "tomorrow", "nextMonday"]);
  });

  test("drops this evening from 17:00", () => {
    expect(summary(local(2026, 9, 30, 17, 0))).toEqual([
      ["tomorrow", "2026-10-01T09:00"],
      ["nextMonday", "2026-10-05T09:00"],
    ]);
    expect(summary(local(2026, 9, 30, 23, 30)).map(([id]) => id)).toEqual(["tomorrow", "nextMonday"]);
  });

  test("next Monday is a full week away on Monday and skipped on Sunday, when it is tomorrow", () => {
    expect(summary(local(2026, 10, 5, 8))).toContainEqual(["nextMonday", "2026-10-12T09:00"]);
    expect(summary(local(2026, 10, 3, 12))).toContainEqual(["nextMonday", "2026-10-05T09:00"]);
    expect(summary(local(2026, 10, 4, 12))).toEqual([
      ["evening", "2026-10-04T18:00"],
      ["tomorrow", "2026-10-05T09:00"],
    ]);
  });

  test("crosses month and year ends", () => {
    expect(summary(local(2026, 12, 31, 20))).toEqual([
      ["tomorrow", "2027-01-01T09:00"],
      ["nextMonday", "2027-01-04T09:00"],
    ]);
  });
});

describe("custom snooze time", () => {
  const now = new Date(2026, 8, 30, 10, 0);

  test("reads the datetime-local value as local time", () => {
    const result = parseSnoozeInput("2026-10-02T14:30", now);
    expect(result.ok && toDateTimeLocalValue(result.until)).toBe("2026-10-02T14:30");
    const withSeconds = parseSnoozeInput("2026-10-02T14:30:45", now);
    expect(withSeconds.ok && withSeconds.until.getSeconds()).toBe(0);
  });

  test("rejects malformed, past and too-distant times", () => {
    for (const value of ["", "tomorrow", "2026-10-02", "2026-02-30T09:00", "2026-10-02T24:00", "2026-10-02T09:60"]) {
      expect(parseSnoozeInput(value, now)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(parseSnoozeInput("2026-09-30T10:00", now)).toEqual({ ok: false, reason: "past" });
    expect(parseSnoozeInput("2026-09-29T23:00", now)).toEqual({ ok: false, reason: "past" });
    const limit = snoozeLimit(now);
    expect(parseSnoozeInput(toDateTimeLocalValue(limit), now).ok).toBe(true);
    expect(parseSnoozeInput(toDateTimeLocalValue(new Date(limit.getTime() + 60_000)), now)).toEqual({ ok: false, reason: "tooFar" });
  });

  test("the limit is one calendar year ahead", () => {
    expect(snoozeLimit(new Date("2026-09-30T12:00:00.000Z")).toISOString()).toBe("2027-09-30T12:00:00.000Z");
  });
});

describe("merge preview", () => {
  test("matches the block the server appends", () => {
    expect(mergeBlock({ title: "제목", body: "새 인용문", url: "https://example.com/a" })).toBe("새 인용문\n\nhttps://example.com/a");
    expect(mergeBlock({ title: "제목", body: "see https://example.com/a", url: "https://example.com/a" })).toBe("see https://example.com/a");
    expect(mergeBlock({ title: "제목만", body: "", url: null })).toBe("제목만");
    expect(mergeBlock({ title: "제목", body: `메모\n\n${URL_PENDING_MARKER}`, url: null })).toBe("메모");
  });

  test("leads with Jev's suggestion until the owner types a query", () => {
    const results = [
      { id: "n1", title: "바질 키우기", matchedAlias: null },
      { id: "n2", title: "허브", matchedAlias: "바질" },
    ];
    const suggestion = { noteId: "n2", title: "허브" };
    expect(mergeOptions(results, suggestion, "").map((o) => [o.id, o.suggested])).toEqual([["n2", true], ["n1", false]]);
    expect(mergeOptions(results, suggestion, "바질").map((o) => [o.id, o.suggested, o.matchedAlias])).toEqual([
      ["n1", false, null],
      ["n2", true, "바질"],
    ]);
    expect(mergeOptions([], { noteId: "n9", title: "휴지통 노트" }, " ").map((o) => o.id)).toEqual(["n9"]);
    expect(mergeOptions(results, null, "").map((o) => o.id)).toEqual(["n1", "n2"]);
  });
});

describe("draft refresh", () => {
  test("adopts fresh server fields without replacing dirty user fields", () => {
    const pristine = { title: "처음", body: "대기", sourceTitle: "처음", sourceBody: "대기", titleDirty: false, bodyDirty: false };
    expect(syncTriageDraft(pristine, "서버 제목", "가져온 본문")).toMatchObject({ title: "서버 제목", body: "가져온 본문" });

    const dirty = { ...pristine, title: "내 제목", body: "내 본문", titleDirty: true, bodyDirty: true };
    expect(syncTriageDraft(dirty, "서버 제목", "가져온 본문")).toEqual({
      ...dirty,
      sourceTitle: "서버 제목",
      sourceBody: "가져온 본문",
    });
  });
});

describe("mergeTags", () => {
  test("normalises, dedupes and keeps manual tags first", () => {
    expect(mergeTags(" #Idea, 학습 ,idea\n", ["Reference", "학습"])).toEqual(["idea", "학습", "reference"]);
    expect(mergeTags("", [])).toEqual([]);
  });
});

describe("suggestionView", () => {
  test("distinguishes not-yet, unavailable, failed and ready", () => {
    expect(suggestionView(null)).toEqual({ kind: "pending" });
    expect(suggestionView({ status: "unavailable", tags: [], kind: null, duplicateOf: null })).toEqual({ kind: "unavailable" });
    expect(suggestionView({ status: "failed", tags: [], kind: null, duplicateOf: null })).toEqual({ kind: "failed" });
    const ready = { status: "ready" as const, tags: [{ tag: "idea", probability: 0.9 }], kind: null, duplicateOf: null };
    expect(suggestionView(ready)).toEqual({ kind: "ready", suggestions: ready });
  });
});

describe("url status lines", () => {
  test("are detected and stripped from the body shown to the user", () => {
    const pending = "메모\n\n> URL 내용을 가져오는 중입니다.";
    expect(urlStatus(pending)).toBe("pending");
    expect(stripUrlStatus(pending)).toBe("메모");
    const failed = "> URL 내용을 가져오지 못했습니다. 원문 링크는 보존되었습니다.";
    expect(urlStatus(failed)).toBe("failed");
    expect(stripUrlStatus(failed)).toBe("");
    expect(urlStatus(`memo\n\n${URL_PENDING_MARKER}`)).toBe("pending");
    expect(stripUrlStatus(`memo\n\n${URL_FAILED_MARKER}`)).toBe("memo");
    expect(urlStatus("평범한 본문")).toBeNull();
    expect(excerpt("첫 줄\n둘째 줄  셋째", 8)).toBe("첫 줄 둘째 …");
    expect(excerpt("짧다")).toBe("짧다");
  });
});

describe("formatCreated", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  test("formats in the requested locale", () => {
    for (const locale of LOCALES) expect(formatCreated("2026-09-27T12:00:10.000Z", locale, now)).toBe(INBOX_COPY[locale].justNow);
    for (const iso of ["2026-09-27T11:55:00.000Z", "2026-09-27T09:00:00.000Z", "2026-09-25T12:00:00.000Z", "2026-09-01T12:00:00.000Z"]) {
      expect(formatCreated(iso, "en", now)).not.toBe(formatCreated(iso, "ko", now));
    }
  });

  test("shows older items as a full date and time without seconds", () => {
    for (const locale of LOCALES) expect(formatCreated("2026-09-01T12:00:45.000Z", locale, now)).not.toMatch(/\d:\d{2}:\d{2}/);
    expect(formatCreated("2026-09-01T12:00:45.000Z", "ko", now)).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });
});

describe("kindLabel", () => {
  test("labels known kinds and shows unknown ids as stored", () => {
    for (const locale of LOCALES) {
      const labels = INBOX_COPY[locale].kind;
      expect(kindLabel("reference", labels)).toBe(labels.reference);
      expect(kindLabel("custom", labels)).toBe("custom");
      expect(kindLabel("toString", labels)).toBe("toString");
    }
  });
});

describe("inbox copy", () => {
  test("has Korean and English parity", () => {
    expect(copyParityIssues(INBOX_COPY)).toEqual([]);
  });
});
