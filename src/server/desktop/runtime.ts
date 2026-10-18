import { Database } from "bun:sqlite";
import { join } from "node:path";

declare global {
  var __aroDesktopRuntime: Database | undefined;
}

export function desktopLock(directory: string, name = "runtime.lock.sqlite"): Database {
  const lock = new Database(join(directory, name), { create: true });
  try {
    lock.run("PRAGMA busy_timeout=0");
    lock.run("BEGIN IMMEDIATE");
  } catch (error) {
    lock.close();
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") {
      throw new Error("Desktop already running for this data directory (database is locked)");
    }
    throw error;
  }
  return lock;
}

function watchLauncher(): void {
  process.stdin.once("end", () => process.kill(process.pid, "SIGTERM"));
  process.stdin.resume();
}

/** Serialize child entry before Next can bind, including the launcher handoff gap. */
export function ownDesktopServer(directory: string): void {
  const lock = desktopLock(directory, "server.lock.sqlite");
  try {
    // An orphaned dev worker can outlive its Next CLI and still own runtime.
    using runtime = desktopLock(directory);
    runtime.run("ROLLBACK");
  } catch (error) {
    lock.close();
    throw error;
  }
  process.once("exit", () => lock.close());
}

/** The serving process owns the OS lock, including when its launcher is killed. */
export function ownDesktopRuntime(directory: string): void {
  if (globalThis.__aroDesktopRuntime) return;
  let lock: Database;
  try { lock = desktopLock(directory); }
  catch (error) {
    // Never let Next turn an ownership failure into a logged registration error.
    console.error(error instanceof Error ? error.message : "Desktop runtime unavailable");
    process.exit(1);
  }
  globalThis.__aroDesktopRuntime = lock;
  // Keep the transaction until process exit, not merely until SIGTERM is received.
  process.once("exit", () => lock.close());
  // The launcher keeps this pipe open. EOF survives SIGKILL and avoids PID reuse
  // checks; the pipe is inherited by the actual Next dev worker as well.
  watchLauncher();
}
