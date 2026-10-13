import { expect, test } from "bun:test";
import { fetchRetry } from "./fetch-retry.mjs";

function harness(outcomes) {
  const waits = [];
  let calls = 0;
  const request = async () => {
    const outcome = outcomes[calls];
    calls += 1;
    if (outcome instanceof Error) throw outcome;
    return new Response("body", { status: outcome });
  };
  return { waits, calls: () => calls, options: { request, wait: async ms => { waits.push(ms); } } };
}
const init = () => ({});

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
