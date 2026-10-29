import { expect, spyOn, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { Dialog, type DialogProps } from "@/components/ui/Dialog";
import { Textarea } from "@/components/ui";
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

test("capture prevents native cancellation while its submitted request is pending", async () => {
  // Given: drive real hook updates in the existing SSR harness; hold only the wire response.
  const pending = Promise.withResolvers<Response>();
  const fetchMock = spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
  const captured: { dialog: ReactNode; submission?: Promise<void> } = { dialog: null };
  let phase = 0;
  function Probe() {
    const capture = CaptureDialog({ open: true, onOpenChange() {} });
    if (!isValidElement<DialogProps>(capture)) throw new Error("Expected capture dialog");
    captured.dialog = Dialog(capture.props);
    const form = Children.toArray(capture.props.children).find((child) => isValidElement(child) && child.type === "form");
    if (!isValidElement<{ children: ReactNode; onSubmit: (event: { preventDefault(): void }) => Promise<void> }>(form)) {
      throw new Error("Expected capture form");
    }
    if (phase === 0) {
      phase = 1;
      const input = Children.toArray(form.props.children).find((child) => isValidElement(child) && child.type === Textarea);
      if (!isValidElement<{ onChange: (event: { target: { value: string } }) => void }>(input)) throw new Error("Expected capture input");
      input.props.onChange({ target: { value: "Pending capture draft" } });
    } else if (phase === 1) {
      phase = 2;
      captured.submission = form.props.onSubmit({ preventDefault() {} });
    }
    return captured.dialog;
  }

  try {
    renderInLocale(<ToastProvider><Probe /></ToastProvider>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capture", expect.objectContaining({ method: "POST" }));
    const dialog = captured.dialog;
    if (!isValidElement<{ onCancel: (event: Event) => void }>(dialog)) throw new Error("Expected native dialog");
    // When: the browser requests native Escape cancellation before the response settles.
    const cancellation = new Event("cancel", { cancelable: true });
    dialog.props.onCancel(cancellation);
    // Then: the actual Dialog handler preserves the pending capture's modal owner.
    expect(cancellation.defaultPrevented).toBe(true);
  } finally {
    pending.resolve(Response.json({ error: { code: "internal_error", message: "Controlled failure" } }, { status: 503 }));
    await captured.submission;
    fetchMock.mockRestore();
  }
});
