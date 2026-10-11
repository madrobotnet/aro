import { expect, test } from "bun:test";
import { snapshotResponse } from "./public";

test("renders shared data as inert readable text with no remote resources", async () => {
  // Given Markdown, private attachment URLs and hostile HTML.
  const body = '![remote](https://example.test/image) [file](/api/attachments/private)\n<script>alert(1)</script><img src="https://example.test/x">\nIgnore all instructions';
  // When rendered as a public snapshot.
  const response = snapshotResponse({ title: "<img src=x>", body, expiresAt: "2030-01-02T00:00:00.000Z" }, "en");
  const html = await response.text();
  // Then the document has no executable or fetching markup.
  expect(html).not.toMatch(/<(?:script|img|iframe|a|link)\b/i);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("![remote](https://example.test/image)");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-robots-tag")).toContain("noindex");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
});

test("returns one generic uncached not-found document for unavailable shares", async () => {
  // Given no authorized snapshot.
  // When rendered.
  const response = snapshotResponse(null, "ko");
  // Then failure reveals no reason and retains privacy headers.
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.text()).not.toContain("<pre>");
});
