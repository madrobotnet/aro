import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { SWRConfig } from "swr";
import { ToastProvider } from "@/components/ui";
import { renderInLocale } from "@/features/setup/test-locale";
import { NoteDetail } from "./NoteDetail";
import { NoteList } from "./NoteList";

function headingLevels(node: ReactNode): number[] {
  const unexpectedNavigation = () => { throw new Error("Navigation during server render"); };
  const router: AppRouterInstance = {
    back: unexpectedNavigation, forward: unexpectedNavigation, refresh: unexpectedNavigation,
    push: unexpectedNavigation, replace: unexpectedNavigation, prefetch: unexpectedNavigation,
    bfcacheId: "note-headings-test",
  };
  const markup = renderInLocale(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/notes">
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <SWRConfig value={{ provider: () => new Map() }}>
            <ToastProvider>{node}</ToastProvider>
          </SWRConfig>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
  return [...markup.matchAll(/<h([1-6])(?:\s[^>]*)?>/g)].map(match => Number(match[1]));
}

test("the unselected notes list owns the page heading", () => {
  // Given the list-only route, when rendered, then it supplies one page heading.
  const levels = headingLevels(<NoteList />);
  expect(levels[0]).toBe(1);
  expect(levels.filter(level => level === 1)).toHaveLength(1);
});

test("the selected notes list is a subordinate pane", () => {
  // Given a selected detail, when its list renders, then the detail owns H1.
  const levels = headingLevels(<NoteList selectedId="selected-note" />);
  expect(levels[0]).toBe(2);
  expect(levels).not.toContain(1);
});

test("a selected note retains its page heading while loading", () => {
  // Given no cached detail, when rendered, then the loading region owns H1.
  const levels = headingLevels(<NoteDetail noteId="uncached-note" />);
  expect(levels.filter(level => level === 1)).toHaveLength(1);
});
