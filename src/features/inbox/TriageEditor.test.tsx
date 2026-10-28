import { expect, test } from "bun:test";
import { createRef, isValidElement } from "react";
import { captureTree } from "@/features/setup/test-locale";
import { LOCALES, type Locale } from "@/lib/i18n/locale";
import type { InboxItem } from "@/lib/types";
import { TriageEditor } from "./TriageEditor";
import { triageDraft } from "./triage-drafts";

test.each([
  [true, 13, true, false, 0], [false, 229, true, false, 0],
  [true, 13, false, true, 0], [false, 229, false, true, 0],
  [false, 13, true, false, 1], [false, 13, false, true, 1],
])("triage shortcut composition=%s code=%i ctrl=%s meta=%s submits %i times", (isComposing, keyCode, ctrlKey, metaKey, expected) => {
  const item: InboxItem = {
    id: "123e4567-e89b-42d3-a456-426614174001",
    title: "Capture", body: "한글 draft", source: "web", url: null,
    preview: "", homePreview: "", createdAt: "2026-09-29T00:00:00Z", suggestions: null, snoozedUntil: null,
  };
  const form = captureTree(TriageEditor, {
    item, draft: triageDraft(item), onDraftChange() {}, titleRef: createRef<HTMLInputElement>(), busy: null,
    onPromote: async () => {}, onDiscard() {}, onSnooze() {}, onMerge() {}, onSuggest: async () => {},
  });
  type ShortcutEvent = {
    key: string; ctrlKey: boolean; metaKey: boolean;
    nativeEvent: { isComposing: boolean; keyCode: number };
    preventDefault: () => void; currentTarget: { requestSubmit: () => void };
  };
  if (!isValidElement<{ onKeyDown: (event: ShortcutEvent) => void }>(form)) throw new Error("Expected triage form");
  let submissions = 0;

  form.props.onKeyDown({
    key: "Enter", ctrlKey, metaKey, nativeEvent: { isComposing, keyCode },
    preventDefault() {}, currentTarget: { requestSubmit() { submissions += 1; } },
  });

  expect(submissions).toBe(expected);
});

function submit(title: string, locale: Locale) {
  const promotions: { title: string; body: string; tags: string[] }[] = [];
  const item: InboxItem = {
    id: "123e4567-e89b-42d3-a456-426614174001",
    title, body: "Keep this body.", source: "web", url: null,
    preview: "Keep this body.", homePreview: "Keep this body.",
    createdAt: "2026-09-29T00:00:00Z", suggestions: null, snoozedUntil: null,
  };
  const form = captureTree(TriageEditor, {
    item, draft: triageDraft(item), onDraftChange() {}, titleRef: createRef<HTMLInputElement>(), busy: null,
    onPromote: async (_item, draft) => { promotions.push(draft); },
    onDiscard: () => {}, onSnooze: () => {}, onMerge: () => {}, onSuggest: async () => {},
  }, locale);
  if (!isValidElement<{
    noValidate?: boolean;
    onSubmit: (event: { preventDefault: () => void }) => void;
  }>(form) || form.type !== "form") throw new Error("Expected the triage form");
  form.props.onSubmit({ preventDefault() {} });
  return { promotions, noValidate: form.props.noValidate };
}

test.each([...LOCALES])("triage owns required-title validation in %s instead of browser-language bubbles", (locale) => {
  const result = submit(" \t ", locale);
  expect(result.promotions).toEqual([]);
  expect(result.noValidate).toBe(true);
});

test.each([...LOCALES])("valid %s submission trims the title and keeps the body", (locale) => {
  expect(submit("  User title  ", locale).promotions).toEqual([
    { title: "User title", body: "Keep this body.", tags: [] },
  ]);
});
