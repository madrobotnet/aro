import type { InboxItem } from "@/lib/types";

// setTimeout fires at once for longer delays; a return further off is re-checked after this.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Milliseconds until the inbox should be refetched because a snoozed item comes back, or
 * null when nothing is snoozed. A second of slack lets the server's clock pass the return
 * time first; a return that is already due is re-checked every five seconds until it lands.
 */
export function snoozeRefreshDelay(nextReturnAt: string | null, now: number): number | null {
  if (nextReturnAt === null) return null;
  const at = Date.parse(nextReturnAt);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now + 1_000, 5_000), MAX_TIMER_MS);
}

export type SnoozePresetId = "evening" | "tomorrow" | "nextMonday";
export type SnoozePreset = { id: SnoozePresetId; until: Date };

/**
 * Snooze presets in the viewer's local time: this evening at 18:00 (offered before 17:00),
 * tomorrow at 09:00 and next Monday at 09:00. On Sunday next Monday is tomorrow, so it is
 * left out rather than listed twice.
 */
export function snoozePresets(now: Date): SnoozePreset[] {
  const at = (daysAhead: number, hour: number) => {
    const time = new Date(now);
    time.setDate(time.getDate() + daysAhead);
    time.setHours(hour, 0, 0, 0);
    return time;
  };
  const presets: SnoozePreset[] = [];
  if (now.getHours() < 17) presets.push({ id: "evening", until: at(0, 18) });
  presets.push({ id: "tomorrow", until: at(1, 9) });
  const daysToMonday = (8 - now.getDay()) % 7 || 7;
  if (daysToMonday > 1) presets.push({ id: "nextMonday", until: at(daysToMonday, 9) });
  return presets;
}

/** Latest allowed snooze: one calendar year ahead, the same bound the server checks. */
export function snoozeLimit(now: Date): Date {
  const limit = new Date(now);
  limit.setUTCFullYear(limit.getUTCFullYear() + 1);
  return limit;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Local `YYYY-MM-DDTHH:mm`, the value format of `<input type="datetime-local">`. */
export function toDateTimeLocalValue(time: Date): string {
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}T${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

export type SnoozeInput = { ok: true; until: Date } | { ok: false; reason: "invalid" | "past" | "tooFar" };

/** Reads a datetime-local value as local time and checks it is in the future and within a year. */
export function parseSnoozeInput(value: string, now: Date): SnoozeInput {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!match) return { ok: false, reason: "invalid" };
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const until = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (hour > 23 || minute > 59 || until.getFullYear() !== year || until.getMonth() !== month - 1 || until.getDate() !== day) {
    return { ok: false, reason: "invalid" };
  }
  if (until.getTime() <= now.getTime()) return { ok: false, reason: "past" };
  if (until.getTime() > snoozeLimit(now).getTime()) return { ok: false, reason: "tooFar" };
  return { ok: true, until };
}

/** True while `snoozedUntil` is still ahead of `now`. */
export function isSnoozed(item: Pick<InboxItem, "snoozedUntil">, now: number): boolean {
  return item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > now;
}

