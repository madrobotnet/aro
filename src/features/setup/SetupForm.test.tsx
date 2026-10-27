import { expect, test } from "bun:test";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { parse } from "node-html-parser";
import { SetupForm } from "./SetupForm";
import { renderInLocale } from "./test-locale";

function renderSetup() {
  const unexpectedNavigation = () => { throw new Error("Navigation during server render"); };
  const router: AppRouterInstance = {
    back: unexpectedNavigation, forward: unexpectedNavigation, refresh: unexpectedNavigation,
    push: unexpectedNavigation, replace: unexpectedNavigation, prefetch: unexpectedNavigation,
    bfcacheId: "setup-test",
  };
  return parse(renderInLocale(
    <AppRouterContext.Provider value={router}><SetupForm /></AppRouterContext.Provider>,
  ));
}

test("uses a native POST fallback when setup renders without hydration", () => {
  // Given / When: render the actual setup form with server snapshots.
  const form = renderSetup().querySelector("form");

  // Then: browser fallback cannot encode credentials into a GET query.
  expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
});

test("disables every setup control when setup renders without hydration", () => {
  // Given / When: render the actual setup form before event handlers attach.
  const root = renderSetup();
  const controls = root.querySelectorAll("input, select, textarea, button");

  // Then: neither credentials, optional AI controls nor submit are usable yet.
  expect(root.querySelectorAll('input[name="setupToken"], input[name="password"], input[name="passwordConfirmation"]')).toHaveLength(3);
  expect(controls.length).toBeGreaterThan(3);
  for (const control of controls) {
    expect(control.hasAttribute("disabled") || control.closest("fieldset[disabled]") !== null).toBe(true);
  }
});
