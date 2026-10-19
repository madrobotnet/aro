import { describe, expect, test } from "bun:test";
import { URL_PENDING_MARKER } from "@/lib/inbox-url-status";
import { inboxPreview } from "./preview";

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

  test("cleans legacy link fragments and entities before truncation without mutating the capture", () => {
    const body = `">' <nav>menu</nav><p>지식 &bull; 연결 &amp; 기록</p><script>noise()</script> <p>두 번째 문장</p>`;
    const item = { title: "Legacy link", body, url: "https://example.com/legacy" };
    const preview = inboxPreview(item);
    expect(preview).toBe("지식 • 연결 & 기록 두 번째 문장");
    expect(inboxPreview(item, 8)).toBe("지식 • 연결…");
    expect(item.body).toBe(body);
  });

  test("does not interpret user-typed captures without a link as HTML", () => {
    const body = `">' <p>Literal &bull; and x < y</p>`;
    expect(inboxPreview({ title: "Syntax", body, url: null })).toBe(body);
  });

  test("decodes link entities once and keeps comparison operators", () => {
    const body = "<p>2 &lt; 3 &gt; 1 &amp;lt;tag&amp;gt;</p>";
    expect(inboxPreview({ title: "Link", body, url: "https://example.com" })).toBe("2 < 3 > 1 &lt;tag&gt;");
  });
});
