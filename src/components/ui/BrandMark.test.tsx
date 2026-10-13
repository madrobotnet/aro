import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BRAND_MARK_PATH, BRAND_MARK_VIEWBOX } from "@/lib/brand";
import { BrandMark } from "./BrandMark";

test("BrandMark draws the 아 tile decoratively and keeps caller classes after its defaults", () => {
  const markup = renderToStaticMarkup(<BrandMark className="size-7" />);
  expect(markup).toContain(`viewBox="${BRAND_MARK_VIEWBOX}"`);
  expect(markup).toContain(`d="${BRAND_MARK_PATH}"`);
  expect(markup).toContain('fill-rule="evenodd"');
  expect(markup).toContain('fill="currentColor"');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).toContain('class="brand-mark size-7"');
});
