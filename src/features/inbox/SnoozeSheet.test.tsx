import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { Sheet, type SheetProps } from "@/components/ui/Dialog";
import { renderInLocale } from "@/features/setup/test-locale";
import type { InboxItem } from "@/lib/types";
import { SnoozeSheet } from "./SnoozeSheet";

function presetClick(node: ReactNode): (() => void) | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) continue;
    if (child.type === "ul") {
      const row = Children.toArray(child.props.children)[0];
      if (!isValidElement<{ children: ReactNode }>(row)) throw new Error("Expected preset row");
      const button = row.props.children;
      if (!isValidElement<{ onClick: () => void }>(button)) throw new Error("Expected preset button");
      return button.props.onClick;
    }
    const click = presetClick(child.props.children);
    if (click) return click;
  }
}

test("snooze prevents native cancellation while its request is pending", async () => {
  // Given: real hook updates and a held request at the component's async boundary.
  const item: InboxItem = {
    id: "123e4567-e89b-42d3-a456-426614174001",
    title: "Capture", body: "Retained draft", source: "web", url: null,
    preview: "", homePreview: "", createdAt: "2026-09-29T00:00:00Z",
    suggestions: null, snoozedUntil: null,
  };
  const target = { item, now: Date.UTC(2026, 8, 29, 8) };
  const pending = Promise.withResolvers<void>();
  const captured: { dialog: ReactNode } = { dialog: null };
  let requests = 0;
  let phase = 0;
  function Probe() {
    const sheet = SnoozeSheet({
      target, onOpenChange() {},
      onSnooze() { requests += 1; return pending.promise; },
    });
    if (!isValidElement<SheetProps>(sheet)) throw new Error("Expected snooze sheet");
    captured.dialog = sheet.type === Sheet ? Sheet(sheet.props) : sheet;
    if (phase === 0) phase = 1;
    else if (phase === 1) {
      phase = 2;
      const click = presetClick(captured.dialog);
      if (!click) throw new Error("Expected snooze preset");
      click();
    }
    return captured.dialog;
  }

  try {
    renderInLocale(<Probe />);
    expect(requests).toBe(1);
    const dialog = captured.dialog;
    if (!isValidElement<{ onCancel?: (event: Event) => void }>(dialog) || dialog.type !== "dialog") {
      throw new Error("Expected native dialog");
    }
    // When: Escape requests native cancellation before the request settles.
    const cancellation = new Event("cancel", { cancelable: true });
    dialog.props.onCancel?.(cancellation);
    // Then: the pending request retains its visible modal owner.
    expect(cancellation.defaultPrevented).toBe(true);
  } finally {
    pending.resolve();
    await pending.promise;
  }
});
