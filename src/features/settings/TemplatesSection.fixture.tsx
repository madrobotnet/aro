import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import useSWR, { SWRConfig } from "swr";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { ToastProvider } from "@/components/ui/Toast";
import { fetcher } from "@/lib/api-client";
import type { NoteTemplate } from "@/lib/templates";
import { SETTINGS_COPY } from "./settings-copy";
import { TemplatesSection } from "./TemplatesSection";

const removedId = "00000000-0000-4000-8000-000000000001";
const ready = Promise.withResolvers<void>();
const opened = Promise.withResolvers<void>();
const closed = Promise.withResolvers<void>();
const removed = Promise.withResolvers<void>();

declare global {
  interface Window {
    templateFocusTest: {
      readonly ready: Promise<void>;
      readonly opened: Promise<void>;
      readonly closed: Promise<void>;
      readonly removed: Promise<void>;
      readonly deleteSelector: string;
    };
  }
}

window.templateFocusTest = {
  ready: ready.promise, opened: opened.promise, closed: closed.promise, removed: removed.promise,
  deleteSelector: `section[aria-labelledby="settings-templates"] li:first-child button[aria-label=${JSON.stringify(SETTINGS_COPY.en.templates.remove)}]`,
};

const observer = new MutationObserver(() => {
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) return;
  dialog.addEventListener("close", () => closed.resolve(), { once: true });
  opened.resolve();
  observer.disconnect();
});
observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });

function unexpectedNavigation(): never {
  throw new Error("Template deletion must not navigate");
}
const router: AppRouterInstance = {
  back: unexpectedNavigation, forward: unexpectedNavigation, refresh: unexpectedNavigation,
  push: unexpectedNavigation, replace: unexpectedNavigation, prefetch: unexpectedNavigation,
  bfcacheId: "template-focus-test",
};

function CommitObserver() {
  const { data } = useSWR<{ templates: NoteTemplate[] }>("/api/templates");
  useEffect(() => {
    if (!data) return;
    // Parent passive effects run after the real child's focus-recovery effect.
    if (data.templates.some(template => template.id === removedId)) ready.resolve();
    else removed.resolve();
  }, [data]);
  return <TemplatesSection />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing template test root");
createRoot(root).render(
  <LocaleProvider initialLocale="en">
    <SWRConfig value={{ fetcher, provider: () => new Map(), revalidateOnFocus: false, shouldRetryOnError: false }}>
      <AppRouterContext.Provider value={router}>
        <ToastProvider>
          <input id="other-control" aria-label="Another control" />
          <CommitObserver />
        </ToastProvider>
      </AppRouterContext.Provider>
    </SWRConfig>
  </LocaleProvider>,
);
window.dispatchEvent(new Event("template-focus-loaded"));
