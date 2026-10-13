import { describe, expect, test } from "bun:test";
import { URL_PENDING_MARKER } from "./inbox-url-status";
import { inboxPreview } from "./inbox-preview";

describe("capture preview", () => {
  test("omits a body that repeats the title after whitespace normalization", () => {
    const item = { title: "A captured thought", body: " A captured\nthought " };
    const preview = inboxPreview(item);
    expect(preview).toBe("");
  });

  test("compares the whole body before truncating the preview", () => {
    const title = "a".repeat(120);
    const preview = inboxPreview({ title, body: `${title}\nMore context` }, 120);
    expect(preview).not.toBe("");
    expect(preview.length).toBe(120);
  });

  test("retains added context and removes URL status markers", () => {
    const item = { title: "A thought", body: `A thought\nUseful context\n\n${URL_PENDING_MARKER}` };
    const preview = inboxPreview(item);
    expect(preview).toBe("A thought Useful context");
  });

  test("leaves literal entity and markup text untouched", () => {
    const body = "Explain &amp;lt;tag&amp;gt; and x > y";
    const preview = inboxPreview({ title: "Syntax", body });
    expect(preview).toBe(body);
  });
});
