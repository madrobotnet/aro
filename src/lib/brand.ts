import type { Metadata } from "next";
import type { Locale, LocalizedText } from "./i18n/locale";

/**
 * Aro brand: product names, install name and the approved 아 mark geometry.
 */

/** Product name per UI language. Korean reads 아로; English reads Aro. */
export const BRAND_NAMES: LocalizedText = { ko: "아로", en: "Aro" };

/**
 * Installed-app name: manifest name/short_name, applicationName and the Apple home-screen title.
 * One Latin name for every locale, because an installed app keeps the name it was installed with.
 */
export const INSTALL_NAME = BRAND_NAMES.en;

export const BRAND_DESCRIPTION: LocalizedText = {
  ko: "생각을 캡처하고 정리하고 연결하는 개인 노트 작업대",
  en: "A personal notes workbench for capturing, organizing and connecting ideas.",
};

/**
 * In-app mark: a rounded tile with 아 from 아로 knocked out on a 16-unit grid; fill even-odd.
 * App icons draw the glyph in cream on terracotta; the tab icon uses a pixel-fitted small master.
 */
export const BRAND_MARK_PATH = "M4 0h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4zM8.74 8a2.96 2.96 0 1 0-5.92 0a2.96 2.96 0 1 0 5.92 0zM6.89 8a1.11 1.11 0 1 0-2.22 0a1.11 1.11 0 1 0 2.22 0zM9.48 4.485a.925 .925 0 0 1 1.85 0v2.59h.925a.925 .925 0 0 1 0 1.85h-.925v2.59a.925 .925 0 0 1-1.85 0z";
export const BRAND_MARK_VIEWBOX = "0 0 16 16";

export function brandName(locale: Locale): string {
  return BRAND_NAMES[locale];
}

/** "Screen · Brand", or the brand alone. Root metadata and <DocumentTitle> share it so titles match. */
export function documentTitle(title: string | null | undefined, locale: Locale): string {
  const screen = title?.trim();
  return screen ? `${screen} · ${brandName(locale)}` : brandName(locale);
}

/** Root-layout metadata for one request locale; page titles fill the template. */
export function rootMetadata(locale: Locale): Metadata {
  return {
    title: { default: brandName(locale), template: documentTitle("%s", locale) },
    description: BRAND_DESCRIPTION[locale],
    applicationName: INSTALL_NAME,
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [
        { url: "/icons/icon.svg", type: "image/svg+xml" },
        { url: "/icons/icon-48.png", sizes: "48x48", type: "image/png" },
      ],
      apple: "/icons/icon-192.png",
    },
    appleWebApp: { capable: true, statusBarStyle: "default", title: INSTALL_NAME },
    robots: { index: false, follow: false },
  };
}
