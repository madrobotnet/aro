import { expect, test } from "bun:test";
import { createRef, isValidElement } from "react";
import { captureTree } from "@/features/setup/test-locale";
import { LOCALES, type Locale } from "@/lib/i18n/locale";
import type { InboxItem } from "@/lib/types";
import { TriageEditor } from "./TriageEditor";

function submit(title: string, locale: Locale) {
  const promotions: { title: string; body: string; tags: string[] }[] = [];
  const item: InboxItem = {
    id: "123e4567-e89b-42d3-a456-426614174001",
    title, body: "Keep this body.", source: "web", url: null,
    preview: "Keep this body.", homePreview: "Keep this body.",
    createdAt: "2026-09-29T00:00:00Z", suggestions: null, snoozedUntil: null,
  };
  const form = captureTree(TriageEditor, {
    item, titleRef: createRef<HTMLInputElement>(), busy: null,
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
