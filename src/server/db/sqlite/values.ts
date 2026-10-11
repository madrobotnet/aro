import { z } from "zod";
import { SQLiteFoundationError } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/;

/** PostgreSQL normalizes UUIDs on input; SQLite TEXT must do so explicitly. */
export function sqliteUuid(value: string): string {
  if (!UUID.test(value)) throw new SQLiteFoundationError("representation", "Expected a UUID");
  return value.toLowerCase();
}

/** Fixed-width UTC microseconds preserve SQL ordering and PostgreSQL cursor precision. */
export function sqliteTimestamp(value: string | Date): string {
  const text = value instanceof Date ? value.toISOString() : value;
  const match = UTC.exec(text);
  if (!match) throw new SQLiteFoundationError("representation", "Expected an ISO UTC instant with at most six fractional digits");
  const prefix = match[1];
  const millis = `${prefix}.${(match[2] ?? "").padEnd(6, "0").slice(0, 3)}Z`;
  const parsed = new Date(millis);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== millis) {
    throw new SQLiteFoundationError("representation", "Expected a valid calendar instant");
  }
  return `${prefix}.${(match[2] ?? "").padEnd(6, "0")}Z`;
}

export function sqliteBoolean(value: boolean): number {
  return value ? 1 : 0;
}

export function readSQLiteBoolean(value: bigint): boolean {
  if (value !== 0n && value !== 1n) throw new SQLiteFoundationError("representation", "Expected a stored boolean");
  return value === 1n;
}

/** A row's 64-bit INTEGER is never silently rounded by the driver. */
export function readSQLiteNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new SQLiteFoundationError("representation", "Integer exceeds the public number range");
  return number;
}

export function sqliteJson(value: z.infer<ReturnType<typeof z.json>>): string {
  return JSON.stringify(z.json().parse(value));
}

export function readSQLiteJson(value: string): z.infer<ReturnType<typeof z.json>> {
  return z.json().parse(JSON.parse(value));
}

export function sqliteStringArray(value: readonly string[]): string {
  return JSON.stringify(z.array(z.string()).parse(value));
}

export function readSQLiteStringArray(value: string): string[] {
  return z.array(z.string()).parse(JSON.parse(value));
}
