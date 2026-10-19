import { expect, test } from "bun:test";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { renderInLocale } from "@/features/setup/test-locale";
import { ShellProvider } from "./ShellProvider";
import { Sidebar } from "./Sidebar";

test("collapsed sidebar renders its mark with the rail colour override", () => {
  const unexpectedNavigation = () => { throw new Error("Navigation during server render"); };
  const router: AppRouterInstance = {
    back: unexpectedNavigation, forward: unexpectedNavigation, refresh: unexpectedNavigation,
    push: unexpectedNavigation, replace: unexpectedNavigation, prefetch: unexpectedNavigation,
    bfcacheId: "sidebar-test",
  };
  const markup = renderInLocale(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/">
        <ShellProvider><Sidebar /></ShellProvider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
  expect(markup).not.toContain('data-expanded="true"');
  expect(markup).toContain('class="brand-mark text-rail-accent"');
});
