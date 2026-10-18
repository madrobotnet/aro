import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchRetry } from "./fetch-retry.mjs";
import { materialIO } from "../../scripts/prepare-release-materials.mjs";

function harness(outcomes) {
  const waits = [];
  let calls = 0;
  const request = async () => {
    const outcome = outcomes[calls];
    calls += 1;
    if (outcome instanceof Error) throw outcome;
    if (outcome instanceof Response) return outcome;
    return new Response("body", { status: outcome });
  };
  const reports = [];
  return { waits, reports, calls: () => calls, options: { request, wait: async ms => { waits.push(ms); }, report: line => { reports.push(line); } } };
}
const init = () => ({});

function brokenBody(error = new Error("The socket connection was closed unexpectedly")) {
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (sent) controller.error(error);
      else { sent = true; controller.enqueue(new TextEncoder().encode("partial")); }
    },
  }));
}

const consume = async response => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  if (body !== "body") throw new Error("Checksum mismatch");
  return body;
};

test("a body failing mid-stream after HTTP 503 is downloaded again", async () => {
  // Given
  const h = harness([503, brokenBody(), 200]);
  // When
  const body = await fetchRetry("https://source.example/file", init, { ...h.options, consume });
  // Then
  expect(body).toBe("body");
  expect(h.calls()).toBe(3);
  expect(h.waits).toEqual([1000, 2000]);
  expect(h.reports).toHaveLength(2);
});

test("body failures exhaust the same bounded attempts", async () => {
  const h = harness(Array.from({ length: 4 }, () => brokenBody()));
  await expect(fetchRetry("https://source.example/file", init, { ...h.options, consume }))
    .rejects.toThrow("The socket connection was closed unexpectedly");
  expect(h.calls()).toBe(4);
  expect(h.waits).toEqual([1000, 2000, 4000]);
});

test("checksum verification is inside each download attempt", async () => {
  const h = harness([new Response("corrupt"), 200]);
  expect(await fetchRetry("https://source.example/file", init, { ...h.options, consume })).toBe("body");
  expect(h.calls()).toBe(2);
  expect(h.waits).toEqual([1000]);
});

test("body timeouts are retried once only", async () => {
  const timeout = () => new DOMException("body timed out", "TimeoutError");
  const h = harness([brokenBody(timeout()), brokenBody(timeout()), 200]);
  await expect(fetchRetry("https://source.example/file", init, { ...h.options, consume }))
    .rejects.toThrow("body timed out");
  expect(h.calls()).toBe(2);
  expect(h.waits).toEqual([1000]);
});

test("a missing download fails once even when consumption throws", async () => {
  const h = harness([404, 200]);
  await expect(fetchRetry("https://source.example/file", init, { ...h.options, consume }))
    .rejects.toThrow("HTTP 404");
  expect(h.calls()).toBe(1);
  expect(h.waits).toEqual([]);
});

test("streamed materials remove failed partial files and verify before recording success", async () => {
  // Given: a dropped body, a complete but corrupt body, then the verified input.
  const directory = await mkdtemp(join(tmpdir(), "aro-download-retry-"));
  const records = [];
  const outcomes = [brokenBody(), new Response("corrupt"), new Response("body")];
  let calls = 0;
  const request = spyOn(globalThis, "fetch").mockImplementation(async () => outcomes[calls++]);
  try {
    const { download } = await materialIO(directory, records);
    const sha256 = createHash("sha256").update("body").digest("hex");
    // When
    const row = await download("https://source.example/file", "sources/input", { sha256, bytes: 4 });
    // Then: wx writes can retry without retaining either failed attempt.
    expect(calls).toBe(3);
    expect(await readFile(join(directory, "sources/input"), "utf8")).toBe("body");
    expect(await readdir(join(directory, "sources"))).toEqual(["input"]);
    expect(row.sha256).toBe(sha256);
    expect(row.bytes).toBe(4);
    expect(records).toEqual([row]);
  } finally {
    request.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("a server error is retried with backoff until the source answers", async () => {
  const h = harness([500, 503, 200]);
  const response = await fetchRetry("https://source.example/file", init, h.options);
  expect(response.status).toBe(200);
  expect(h.calls()).toBe(3);
  expect(h.waits).toEqual([1000, 2000]);
});

test("a connection failure is retried and the last one is thrown", async () => {
  const h = harness([new Error("reset"), new Error("reset"), new Error("reset"), new Error("final reset")]);
  await expect(fetchRetry("https://source.example/file", init, h.options)).rejects.toThrow("final reset");
  expect(h.calls()).toBe(4);
  expect(h.waits).toEqual([1000, 2000, 4000]);
});

test("a missing source fails at once without a retry", async () => {
  const h = harness([404, 200]);
  const response = await fetchRetry("https://source.example/file", init, h.options);
  expect(response.status).toBe(404);
  expect(h.calls()).toBe(1);
  expect(h.waits).toEqual([]);
});

test("a persistent server error is returned after the last attempt", async () => {
  const h = harness([500, 500, 429, 502]);
  const response = await fetchRetry("https://source.example/file", init, h.options);
  expect(response.status).toBe(502);
  expect(h.calls()).toBe(4);
});

test("each attempt gets its own request options", async () => {
  const h = harness([500, 200]);
  const seen = [];
  await fetchRetry("https://source.example/file", () => { const value = {}; seen.push(value); return value; }, h.options);
  expect(seen).toHaveLength(2);
  expect(seen[0]).not.toBe(seen[1]);
});

test("a timeout is retried once only", async () => {
  const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const h = harness([timeout(), timeout(), 200]);
  await expect(fetchRetry("https://source.example/file", init, h.options)).rejects.toThrow("timed out");
  expect(h.calls()).toBe(2);
  expect(h.waits).toEqual([1000]);
});

test("every retry is reported with its cause", async () => {
  const h = harness([503, new Error("reset"), 200]);
  await fetchRetry("https://source.example/file", init, h.options);
  expect(h.reports).toHaveLength(2);
  expect(h.reports[0]).toContain("HTTP 503");
  expect(h.reports[0]).toContain("https://source.example/file");
  expect(h.reports[1]).toContain("Error");
});
