import type { ToastItem, ToastOptions } from "./Toast";

export function toastDuration(item: ToastOptions): number {
  return item.durationMs ?? (item.action ? 0 : 3500);
}

export function enqueueToast(items: readonly ToastItem[], item: ToastItem): ToastItem[] {
  const queue = [...items, item];
  let ordinary = queue.filter((entry) => !entry.action).length;
  return queue.filter((entry) => entry.action || ordinary-- <= 4);
}

export function armToastTimer(duration: number, expire: () => void): () => void {
  if (duration <= 0) return () => {};
  const timer = setTimeout(expire, duration);
  return () => clearTimeout(timer);
}

export type ToastAction = () => boolean | void | Promise<boolean | void>;
export type ToastActionState = "idle" | "pending" | "failed" | "complete";

/** Event boundary: failed actions become retryable UI state, never lost recovery. */
export function createToastAction(
  action: ToastAction,
  onSuccess: () => void,
  onState: (state: ToastActionState) => void,
) {
  let state: ToastActionState = "idle";
  return async () => {
    if (state === "pending" || state === "complete") return;
    state = "pending";
    onState(state);
    let result: boolean | void;
    try {
      result = await action();
    } catch {
      // Both Error and non-Error rejections are converted at this UI boundary.
      state = "failed";
      onState(state);
      return;
    }
    state = result === false ? "failed" : "complete";
    onState(state);
    if (state === "complete") onSuccess();
  };
}
