import { Database } from "bun:sqlite";
import { join } from "node:path";

declare global {
  var __aroDesktopRuntime: Database | undefined;
}

/** The serving process owns the OS lock, including when its launcher is killed. */
export function ownDesktopRuntime(directory: string): void {
  if (globalThis.__aroDesktopRuntime) return;
  const lock = new Database(join(directory, "runtime.lock.sqlite"), { create: true });
  try {
    lock.run("PRAGMA busy_timeout=0");
    lock.run("BEGIN IMMEDIATE");
  } catch (error) {
    lock.close();
    throw error;
  }
  globalThis.__aroDesktopRuntime = lock;
  // Keep the transaction until process exit, not merely until SIGTERM is received.
  process.once("exit", () => lock.close());
  // The launcher keeps this pipe open. EOF survives SIGKILL and avoids PID reuse
  // checks; the pipe is inherited by the actual Next dev worker as well.
  process.stdin.once("end", () => process.kill(process.pid, "SIGTERM"));
  process.stdin.resume();
}
