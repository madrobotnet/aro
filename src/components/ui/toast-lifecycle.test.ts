import { afterEach, expect, jest, test } from "bun:test";
import type { ToastItem } from "./Toast";
import { armToastTimer, createToastAction, enqueueToast, toastDuration, type ToastAction } from "./toast-lifecycle";

afterEach(() => jest.useRealTimers());

const message = { ko: "marker", en: "marker" };
const recovery = (id: number): ToastItem => ({
  id, message, action: { label: message, onClick: () => {} },
});

test("keeps recovery after the former six-second timeout when duration is omitted", () => {
  // Given an action whose timeout would be scheduled by ToastCard.
  const item = recovery(1);
  jest.useFakeTimers();
  let items = [item];
  // When the controlled timer boundary receives the default duration.
  armToastTimer(toastDuration(item), () => { items = []; });
  jest.advanceTimersByTime(60_000);
  // Then no expiration can remove the action, focused or otherwise.
  expect(items).toEqual([item]);
});

test("expires ordinary notifications when their timer reaches the deadline", () => {
  // Given a normal notification and a controlled clock.
  jest.useFakeTimers();
  let expired = false;
  armToastTimer(toastDuration({}), () => { expired = true; });
  // When its default lifetime passes.
  jest.advanceTimersByTime(3500);
  // Then it expires.
  expect(expired).toBe(true);
});

test("keeps a notification when focus or hover cancels its timer", () => {
  // Given an explicitly timed action and its effect cleanup.
  jest.useFakeTimers();
  let expired = false;
  const cancel = armToastTimer(toastDuration({ ...recovery(1), durationMs: 100 }), () => { expired = true; });
  // When interaction cleans up the timer before the deadline.
  cancel();
  jest.advanceTimersByTime(1000);
  // Then interaction preserves it.
  expect(expired).toBe(false);
});

test("awaits a successful action and dismisses once despite duplicate activations", async () => {
  // Given an action held at its completion boundary.
  const outcome = Promise.withResolvers<boolean>();
  let calls = 0;
  let dismissals = 0;
  const states: string[] = [];
  const run = createToastAction(() => { calls++; return outcome.promise; }, () => { dismissals++; }, (state) => states.push(state));
  // When it is activated repeatedly before and after success.
  const pending = run();
  await run();
  expect(calls).toBe(1);
  expect(dismissals).toBe(0);
  expect(states).toEqual(["pending"]);
  outcome.resolve(true);
  await pending;
  await run();
  // Then only the confirmed success dismisses, once.
  expect(calls).toBe(1);
  expect(dismissals).toBe(1);
  expect(states).toEqual(["pending", "complete"]);
});

const failures: readonly ToastAction[] = [
  () => false,
  async () => false,
  () => { throw new TypeError("fixture"); },
  () => Promise.reject(new TypeError("fixture")),
  () => Promise.reject("fixture"),
];

for (const [index, fail] of failures.entries()) {
  test(`retains retryable recovery when action failure variant ${index} occurs`, async () => {
    // Given an action that first fails, then succeeds on retry.
    let calls = 0;
    let dismissals = 0;
    const states: string[] = [];
    const run = createToastAction(() => ++calls === 1 ? fail() : true, () => { dismissals++; }, (state) => states.push(state));
    // When the first attempt fails.
    await run();
    // Then it stays open and can subsequently recover.
    expect(dismissals).toBe(0);
    expect(states).toEqual(["pending", "failed"]);
    await run();
    expect(dismissals).toBe(1);
    expect(states).toEqual(["pending", "failed", "pending", "complete"]);
  });
}

test("dismisses legacy synchronous void actions after they return", async () => {
  // Given a synchronous navigation-style action.
  const events: string[] = [];
  const run = createToastAction(() => { events.push("action"); }, () => events.push("dismiss"), () => {});
  // When activated.
  await run();
  // Then the legacy completion contract is preserved.
  expect(events).toEqual(["action", "dismiss"]);
});

test("retains older recovery when ordinary notifications exceed the cap", () => {
  // Given an older recovery action, which may own keyboard focus.
  const first = recovery(1);
  const items = [first];
  // When a burst of ordinary notifications arrives.
  const result = Array.from({ length: 8 }, (_, i) => ({ id: i + 2, message }))
    .reduce(enqueueToast, items);
  // Then the action survives and only ordinary notifications are capped.
  expect(result).toContain(first);
  expect(result.filter((item) => !item.action)).toHaveLength(4);
});

test("retains every recovery when recovery actions exceed four", () => {
  // Given five distinct recovery actions.
  const items = Array.from({ length: 5 }, (_, i) => recovery(i + 1));
  // When they enter the notification queue.
  const result = items.reduce(enqueueToast, []);
  // Then no recovery is silently evicted.
  expect(result).toEqual(items);
});
