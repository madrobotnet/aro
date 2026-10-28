import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { ToastProvider } from "@/components/ui/Toast";
import { renderInLocale } from "@/features/setup/test-locale";
import { LOCALES } from "@/lib/i18n/locale";
import { CaptureDialog } from "./CaptureDialog";

type ShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  nativeEvent: { isComposing: boolean; keyCode: number };
  preventDefault: () => void;
  currentTarget: { requestSubmit: () => void };
};

test.each([
  [true, 13, true, false, 0],
  [false, 229, true, false, 0],
  [true, 13, false, true, 0],
  [false, 229, false, true, 0],
  [false, 13, true, false, 1],
  [false, 13, false, true, 1],
])("capture shortcut composition=%s code=%i ctrl=%s meta=%s submits %i times", (isComposing, keyCode, ctrlKey, metaKey, expected) => {
  const captured: { tree: ReactNode } = { tree: null };
  function Probe() {
    captured.tree = CaptureDialog({ open: true, onOpenChange() {} });
    return null;
  }
  renderInLocale(<ToastProvider><Probe /></ToastProvider>);
  const tree = captured.tree;
  if (!isValidElement<{ children: ReactNode }>(tree)) throw new Error("Expected capture dialog");
  const form = Children.toArray(tree.props.children).find((child) => isValidElement(child) && child.type === "form");
  if (!isValidElement<{ onKeyDown: (event: ShortcutEvent) => void }>(form)) throw new Error("Expected capture form");
  let submissions = 0;

  form.props.onKeyDown({
    key: "Enter", ctrlKey, metaKey, nativeEvent: { isComposing, keyCode },
    preventDefault() {}, currentTarget: { requestSubmit() { submissions += 1; } },
  });

  expect(submissions).toBe(expected);
});

test.each([...LOCALES])("capture uses its own URL validation in %s rather than the browser's language", (locale) => {
  const markup = renderInLocale(
    <ToastProvider><CaptureDialog open onOpenChange={() => {}} /></ToastProvider>,
    locale,
  );
  const forms = markup.match(/<form\b[^>]*>/g) ?? [];
  expect(forms).toHaveLength(1);
  expect(forms[0]).toMatch(/\bnovalidate(?:=|\s|>)/i);
});
