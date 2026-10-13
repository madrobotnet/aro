import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import manifest from "@/app/manifest";
import { LOCALES } from "@/lib/i18n/locale";
import { BRAND_DESCRIPTION, BRAND_MARK_PATH, BRAND_MARK_VIEWBOX, brandName, documentTitle, INSTALL_NAME, rootMetadata } from "./brand";

/** A repository file, resolved from this test file rather than the working directory. */
const repoFile = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url));

/** "WxH" from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): string {
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe("brand names and titles", () => {
  test("each locale has its own brand name and a description", () => {
    expect(new Set(LOCALES.map((locale) => brandName(locale))).size).toBe(LOCALES.length);
    for (const locale of LOCALES) {
      expect(brandName(locale).trim()).not.toBe("");
      expect(BRAND_DESCRIPTION[locale].trim()).not.toBe("");
    }
  });

  test("the metadata title template and client document titles share one format", () => {
    for (const locale of LOCALES) {
      const brand = brandName(locale);
      expect(rootMetadata(locale).title).toEqual({ default: brand, template: documentTitle("%s", locale) });
      const titled = documentTitle("  Probe  ", locale);
      expect(titled.startsWith("Probe")).toBe(true);
      expect(titled.endsWith(brand)).toBe(true);
      for (const empty of ["", "   ", null, undefined]) expect(documentTitle(empty, locale)).toBe(brand);
    }
  });

  test("every install surface uses the one install name", () => {
    const app = manifest();
    expect(app.name).toBe(INSTALL_NAME);
    expect(app.short_name).toBe(INSTALL_NAME);
    for (const locale of LOCALES) {
      const meta = rootMetadata(locale);
      expect(meta.applicationName).toBe(INSTALL_NAME);
      expect(meta.appleWebApp).toMatchObject({ title: INSTALL_NAME });
    }
  });
});

describe("brand assets", () => {
  test("manifest icons exist at their declared sizes for both install purposes", () => {
    const icons = manifest().icons ?? [];
    for (const purpose of ["any", "maskable"]) expect(icons.some((icon) => icon.purpose === purpose)).toBe(true);
    for (const icon of icons) expect(pngSize(repoFile(`public${icon.src}`))).toBe(icon.sizes ?? "");
  });

  test("metadata icons point at existing files of the declared size", () => {
    const icons = rootMetadata("en").icons;
    if (!icons || typeof icons !== "object" || Array.isArray(icons) || icons instanceof URL) throw new Error("expected an icons object");
    const list = Array.isArray(icons.icon) ? icons.icon : [];
    expect(list.length).toBeGreaterThan(0);
    for (const icon of list) {
      if (typeof icon !== "object" || icon instanceof URL) throw new Error("expected icon descriptors");
      const bytes = repoFile(`public${String(icon.url)}`);
      if (icon.sizes) expect(pngSize(bytes)).toBe(icon.sizes);
    }
    expect(icons.apple).toBe("/icons/icon-192.png");
    expect(pngSize(repoFile("public/icons/icon-192.png"))).toBe("192x192");
  });

  test("the in-app mark retains the approved path and viewBox", () => {
    expect(BRAND_MARK_VIEWBOX).toBe("0 0 16 16");
    expect(BRAND_MARK_PATH).toBe("M4 0h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4zM8.74 8a2.96 2.96 0 1 0-5.92 0a2.96 2.96 0 1 0 5.92 0zM6.89 8a1.11 1.11 0 1 0-2.22 0a1.11 1.11 0 1 0 2.22 0zM9.48 4.485a.925 .925 0 0 1 1.85 0v2.59h.925a.925 .925 0 0 1 0 1.85h-.925v2.59a.925 .925 0 0 1-1.85 0z");
  });

  test("the tab icon uses its small master and the docs icon uses its app master", () => {
    const favicon = repoFile("public/icons/icon.svg").toString("utf8");
    expect(favicon).toContain(`viewBox="${BRAND_MARK_VIEWBOX}"`);
    expect(favicon).toContain('d="M5 5a3 3 0 1 0 0 6a3 3 0 0 0 0-6zm0 2a1 1 0 1 1 0 2a1 1 0 0 1 0-2zM9 3h2v4h2v2h-2v4H9z"');
    expect(favicon).toContain('fill-rule="evenodd"');
    const appIcon = repoFile("docs/images/aro-mark.svg").toString("utf8");
    expect(appIcon).toContain('viewBox="0 0 512 512"');
    expect(appIcon).toContain('d="M8.66 8a2.64 2.64 0 1 0-5.28 0a2.64 2.64 0 1 0 5.28 0zM7.01 8a.99 .99 0 1 0-1.98 0a.99 .99 0 1 0 1.98 0zM9.32 4.865a.825 .825 0 0 1 1.65 0v2.31h.825a.825 .825 0 0 1 0 1.65h-.825v2.31a.825 .825 0 0 1-1.65 0z"');
    expect(appIcon).toContain('fill-rule="evenodd"');
  });
});
