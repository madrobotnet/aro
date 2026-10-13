import { lockThread } from "./sqlite-lock";

// Offline child fixture: IPC reports acquisition before the parent acts.
const [filename, threadId] = process.argv.slice(2);
if (!filename || !threadId) throw new Error("Missing fixture arguments");
try {
  const unlock = await lockThread(filename, threadId);
  process.on("message", () => {
    unlock();
    process.exit(0);
  });
  process.on("disconnect", () => {
    unlock();
    process.exit(0);
  });
  process.send?.({ state: "locked" });
} catch (error) {
  const message = { state: "rejected", code: error instanceof Error && "code" in error ? error.code : null };
  // Explicit process.exit before the IPC write callback drops the packet on Windows.
  if (process.send) process.send(message, () => process.exit(0));
  else process.exit(0);
}
