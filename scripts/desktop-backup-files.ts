import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { windowsPrivatePath } from "../src/server/desktop/windows-private-path";

export class DesktopBackupError extends Error {
  constructor(message: string, readonly code: "backup" | "platform-mismatch" = "backup") {
    super(message); this.name = "DesktopBackupError";
  }
}

function fail(message: string): never { throw new DesktopBackupError(message); }

export async function ownedPath(path: string, directory: boolean, privateDirectory = false) {
  if (!isAbsolute(path) || resolve(path) !== path) fail("Use canonical absolute paths");
  const info = await lstat(path);
  if (process.platform === "win32") {
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
        (!directory && info.nlink !== 1) || await realpath(path) !== path) {
      fail("Paths must be regular and free of reparse points");
    }
    if (privateDirectory) await windowsPrivatePath(path, true);
    return info;
  }
  if (info.isSymbolicLink() ||
      info.uid !== process.getuid?.() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (privateDirectory && (info.mode & 0o077) !== 0) ||
      (directory ? (info.mode & 0o500) !== 0o500 : (info.mode & 0o400) !== 0o400) ||
      (info.mode & 0o7000) !== 0 || (!directory && info.nlink !== 1)) {
    fail("Paths must be owned, regular, and free of symlinks; root directories must be private");
  }
  // Bun 1.4.2 realpath treats literal backslashes in legacy Linux names incorrectly.
  // lstat every ancestor instead, so these valid bytes survive without following links.
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const ancestor = await lstat(parent);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) fail("Symlink ancestor refused");
    if (parent === "/") break;
  }
  return info;
}

/** Bounded buffer; no whole database or attachment is loaded into memory. */
export async function hashOrCopy(source: string, destination?: string) {
  const before = await ownedPath(source, false);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await input.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail("Source changed");
    const output = destination === undefined ? undefined :
      await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let size = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        size += bytesRead;
        if (output) {
          let offset = 0;
          while (offset < bytesRead) {
            const written = await output.write(chunk, offset, bytesRead - offset, null);
            if (written.bytesWritten === 0) fail("Copy made no progress");
            offset += written.bytesWritten;
          }
        }
      }
      const after = await input.stat();
      const current = await ownedPath(source, false);
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev) fail("Source changed");
      if (output) {
        if (process.platform !== "win32") await output.chmod(before.mode & 0o777);
        await output.sync();
      }
      return { size, sha256: hash.digest("hex"),
        ...(process.platform === "win32" ? {} : { mode: before.mode & 0o777 }) };
    } finally { await output?.close(); }
  } finally { await input.close(); }
}
