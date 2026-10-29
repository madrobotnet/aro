"use client";

import { useSyncExternalStore } from "react";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { StatusScreen } from "@/components/shell/StatusScreen";
import { ThemeProvider } from "@/components/shell/ThemeProvider";
import { THEME_INIT_SCRIPT } from "@/components/shell/theme";
import { detectLocale, FALLBACK_LOCALE, readDocumentLocale, type Locale } from "@/lib/i18n/locale";
import "./globals.css";

const subscribeNever = () => () => undefined;

/** The browser's own choice: the sb_locale cookie, else its language list (as the server does with headers). */
function readBrowserLocale(): Locale {
  return readDocumentLocale() ?? detectLocale(navigator.languages.join(","));
}

/**
 * Replaces the root layout when it fails, so it brings its own document, styles, theme and locale.
 * Server render and hydration use the fallback locale; the browser's locale applies right after.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const locale = useSyncExternalStore(subscribeNever, readBrowserLocale, () => FALLBACK_LOCALE);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head>
      <body className="bg-canvas text-ink antialiased">
        <ThemeProvider>
          <LocaleProvider initialLocale={locale}>
            <StatusScreen kind="error" onRetry={retry} digest={error.digest} />
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
