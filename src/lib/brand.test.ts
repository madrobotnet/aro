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

  test("the favicon and the docs mark carry the BrandMark geometry", () => {
    const favicon = repoFile("public/icons/icon.svg").toString("utf8");
    expect(favicon).toContain(`viewBox="${BRAND_MARK_VIEWBOX}"`);
    expect(favicon).toContain(`d="${BRAND_MARK_PATH}"`);
    expect(favicon).toContain('fill-rule="evenodd"');
    expect(repoFile("docs/images/aro-mark.svg").toString("utf8")).toContain(`d="${BRAND_MARK_PATH}"`);
  });
});
