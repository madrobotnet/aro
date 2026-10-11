import { Database, SQLiteError } from "bun:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ApiError } from "@/server/http";
import { chatCopy } from "@/server/i18n/copy";
import { validId } from "./service";

/**
 * A dedicated persistent SQLite file per canonical thread, never the app DB.
 * Never unlink these files: another process may still own the original inode.
 * No lease expiry; SQLite/the kernel release the writer on close/process death.
 */
export function lockThread(filename: string, threadId: string): () => void {
  validId(threadId);
  if (!isAbsolute(filename)) throw new Error("Expected an absolute SQLite filename");
  const directory = `${filename}.chat-locks`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error("Chat lock directory must be private and not a symlink");
  }
  const path = join(directory, `${threadId.toLowerCase()}.sqlite`);
  // Only open/close an fd when creating a NEW inode. Closing any unrelated fd
  // for an already locked inode drops that process's POSIX SQLite locks.
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const file = lstatSync(path);
    if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error("Chat lock file must be a private regular file");
  }
  const lock = new Database(path, { strict: true });
  try {
    lock.run("PRAGMA busy_timeout = 0");
    lock.run("BEGIN IMMEDIATE");
  } catch (error) {
    lock.close(true);
    if (error instanceof SQLiteError && (error.errno === 5 || error.errno === 6)) {
      throw new ApiError("conflict", chatCopy.busy);
    }
    throw error;
  }
  return () => {
    try {
      lock.run("ROLLBACK");
    } finally {
      lock.close(true);
    }
  };
}
