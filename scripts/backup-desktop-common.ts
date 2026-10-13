import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, relative, sep, posix } from "node:path";
import { ownedPath, hashOrCopy, DesktopBackupError } from "./desktop-backup-files";
export { ownedPath, hashOrCopy, DesktopBackupError } from "./desktop-backup-files";
import { windowsPrivatePath } from "../src/server/desktop/windows-private-path";
import { MAX_MANIFEST_BYTES, MAX_ENTRIES, safePath, manifestSchema, parseDesktopManifest,
  type Entry, type Manifest } from "./desktop-backup-manifest";


function fail(message: string): never { throw new DesktopBackupError(message); }


async function optionalPath(path: string, directory: boolean) {
  try { return await ownedPath(path, directory); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function absentOutput(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) fail("Use canonical absolute paths");
  await ownedPath(dirname(path), true, true);
  try { await lstat(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  fail("Output already exists");
}

/** Only called on directories created by this operation, never on input paths. */
async function removeCreatedTree(directory: string): Promise<void> {
  await ownedPath(directory, true);
  if (process.platform !== "win32") await chmod(directory, 0o700);
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink()) await removeCreatedTree(path);
  }
  await rm(directory, { recursive: true, force: true });
}


async function inventory(directory: string, relative = "", entries: Entry[] = []): Promise<Entry[]> {
  for (const name of (await readdir(join(directory, relative))).sort()) {
    if (relative === "" && name === "manifest.json") continue;
    const path = relative ? `${relative}/${name}` : name;
    safePath.parse(path);
    if (entries.length >= MAX_ENTRIES) fail("Too many backup entries");
    const full = join(directory, path);
    const info = await lstat(full);
    if (info.isDirectory()) {
      await ownedPath(full, true);
      entries.push({ kind: "directory", path,
        ...(process.platform === "win32" ? {} : { mode: info.mode & 0o777 }) });
      await inventory(directory, path, entries);
    } else {
      entries.push({ kind: "file", path, ...await hashOrCopy(full) });
    }
  }
  return entries;
}

function checkManifest(manifest: Manifest): void {
  const paths = new Map<string, Entry>();
  for (const entry of manifest.entries) {
    if (paths.has(entry.path)) fail("Duplicate manifest path");
    if (entry.path === "aro.sqlite" && entry.kind !== "file") fail("Invalid database entry");
    if (entry.path === "attachments" && entry.kind !== "directory") fail("Invalid attachment directory");
    paths.set(entry.path, entry);
  }
  if (paths.get("aro.sqlite")?.kind !== "file") fail("Database entry missing");
  for (const entry of manifest.entries) {
    if (entry.path.includes("/") && paths.get(posix.dirname(entry.path))?.kind !== "directory") {
      fail("Manifest parent directory missing");
    }
  }
}

function sameInventory(left: readonly Entry[], right: readonly Entry[]): boolean {
  const sortedLeft = [...left].sort((a, b) => a.path.localeCompare(b.path));
  const sortedRight = [...right].sort((a, b) => a.path.localeCompare(b.path));
  return sortedLeft.length === sortedRight.length && sortedLeft.every((entry, index) => {
    const other = sortedRight[index];
    if (!other || entry.path !== other.path || entry.kind !== other.kind ||
        ("mode" in entry ? entry.mode : undefined) !== ("mode" in other ? other.mode : undefined)) return false;
    switch (entry.kind) {
      case "directory": return true;
      case "file": return other.kind === "file" && entry.size === other.size && entry.sha256 === other.sha256;
    }
  });
}

/** Opens only a snapshot, never the live database. Checks all rows and referenced files. */
async function checkDatabase(directory: string, entries: readonly Entry[]): Promise<void> {
  using db = new Database(join(directory, "aro.sqlite"), { readonly: true, strict: true });
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" ||
      db.query("PRAGMA foreign_key_check").get() !== null) fail("SQLite integrity verification failed");
  const files = new Map(entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]));
  for (const row of db.query<{ storage_key: string; size_bytes: number }, []>(
    "SELECT storage_key,size_bytes FROM attachments").iterate()) {
    if (typeof row.storage_key !== "string" || row.storage_key.includes("/") ||
        (process.platform === "win32" && row.storage_key.includes("\\")) ||
        row.storage_key.includes("\0") || row.storage_key === "." || row.storage_key === "..") {
      fail("Invalid attachment storage key");
    }
    const entry = files.get(`attachments/${row.storage_key}`);
    if (!entry || entry.size !== row.size_bytes) fail("Attachment identity verification failed");
  }
}

/** Optional operator seam runs after snapshot completion while the runtime lock is held. */
export async function backupDesktop(dataDirectory: string, output: string, afterSnapshot?: () => Promise<void>): Promise<void> {
  const rootInfo = await ownedPath(dataDirectory, true, true);
  await absentOutput(output);
  const outputRelative = relative(dataDirectory, output);
  if (!isAbsolute(outputRelative) && outputRelative.split(sep)[0] !== "..") fail("Backup must be outside the data directory");
  await ownedPath(join(dataDirectory, "aro.sqlite"), false);
  // SQLite may open these itself. Reject links before native SQLite sees them.
  for (const name of ["aro.sqlite-wal", "aro.sqlite-shm", "aro.sqlite-journal",
    "runtime.lock.sqlite", "runtime.lock.sqlite-wal", "runtime.lock.sqlite-shm", "runtime.lock.sqlite-journal"]) {
    await optionalPath(join(dataDirectory, name), false);
  }
  const lockPath = join(dataDirectory, "runtime.lock.sqlite");
  if (!await optionalPath(lockPath, false)) {
    const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  }
  using lock = new Database(lockPath, { strict: true });
  lock.run("PRAGMA busy_timeout=0");
  try { lock.run("BEGIN IMMEDIATE"); }
  catch { fail("Stop the desktop application before backup; launcher lock is unavailable"); }
  let created = false;
  let completed = false;
  try {
    await mkdir(output, { mode: 0o700 });
    created = true;
    if (process.platform === "win32") await windowsPrivatePath(output, true);
    // Native SQLite snapshot reads committed WAL pages; never copies the main file raw.
    {
      using source = new Database(join(dataDirectory, "aro.sqlite"), { readonly: true, strict: true });
      source.run("PRAGMA busy_timeout=0");
      source.run("VACUUM INTO ?", [join(output, "aro.sqlite")]);
    }
    if (process.platform !== "win32") await chmod(join(output, "aro.sqlite"), (await ownedPath(join(dataDirectory, "aro.sqlite"), false)).mode & 0o777);
    const attachments = join(dataDirectory, "attachments");
    let copiedEntries = 1;
    const copyTree = async (source: string, target: string): Promise<void> => {
      if (++copiedEntries > MAX_ENTRIES) fail("Too many backup entries");
      const info = await ownedPath(source, true);
      await mkdir(target, { mode: 0o700 });
      for (const name of (await readdir(source)).sort()) {
        const input = join(source, name);
        const child = await lstat(input);
        if (child.isDirectory()) await copyTree(input, join(target, name));
        else {
          if (++copiedEntries > MAX_ENTRIES) fail("Too many backup entries");
          await hashOrCopy(input, join(target, name));
        }
      }
      if (process.platform !== "win32") await chmod(target, info.mode & 0o777);
    };
    if (await optionalPath(attachments, true)) await copyTree(attachments, join(output, "attachments"));
    const entries = await inventory(output);
    await checkDatabase(output, entries);
    const manifest = manifestSchema.parse({
      format: "aro-desktop-backup", createdAt: new Date().toISOString(),
      sqliteSnapshot: "vacuum-into", entries,
      ...(process.platform === "win32"
        ? { version: 2, platform: "win32", permissionModel: "windows-acl" }
        : { version: 1, dataDirectoryMode: rootInfo.mode & 0o777 }),
    });
    checkManifest(manifest);
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    if (bytes.length > MAX_MANIFEST_BYTES) fail("Manifest too large");
    const handle = await open(join(output, "manifest.json"), "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    completed = true;
    await afterSnapshot?.();
  } catch (error) {
    if (created && !completed) await removeCreatedTree(output);
    throw error;
  } finally { lock.run("ROLLBACK"); }
}

export async function verifyDesktopBackup(backup: string, temporaryParent: string): Promise<void> {
  await ownedPath(backup, true, true);
  await ownedPath(temporaryParent, true, true);
  const sandboxRelative = relative(backup, temporaryParent);
  if (!isAbsolute(sandboxRelative) && sandboxRelative.split(sep)[0] !== "..") fail("Sandbox must be outside backup");
  const manifestInfo = await ownedPath(join(backup, "manifest.json"), false);
  if (manifestInfo.size > MAX_MANIFEST_BYTES) fail("Manifest too large");
  const handle = await open(join(backup, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest: Manifest;
  try {
    // Bound the read itself, not just the preceding stat, if the input grows.
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > MAX_MANIFEST_BYTES) fail("Manifest too large");
    manifest = parseDesktopManifest(JSON.parse(bytes.subarray(0, size).toString("utf8")));
  }
  finally { await handle.close(); }
  checkManifest(manifest);
  // Hash and validate every input before creating any restore sandbox.
  const actual = await inventory(backup);
  if (!sameInventory(actual, manifest.entries)) fail("Backup checksum or inventory mismatch");
  const sandbox = await mkdtemp(join(temporaryParent, "aro-desktop-verify-"));
  try {
    await ownedPath(sandbox, true, true);
    for (const entry of manifest.entries.filter((entry) => entry.kind === "directory")
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length)) {
      await mkdir(join(sandbox, entry.path), { mode: 0o700 });
    }
    for (const entry of manifest.entries) {
      if (entry.kind !== "file") continue;
      const copied = await hashOrCopy(join(backup, entry.path), join(sandbox, entry.path));
      if (copied.size !== entry.size || copied.sha256 !== entry.sha256 ||
          ("mode" in entry && copied.mode !== entry.mode)) fail("Backup changed during verification");
    }
    for (const entry of [...manifest.entries].reverse()) {
      if (entry.kind === "directory" && "mode" in entry) await chmod(join(sandbox, entry.path), entry.mode);
    }
    if (manifest.version === 1) await chmod(sandbox, manifest.dataDirectoryMode);
    const restored = await inventory(sandbox);
    if (!sameInventory(restored, manifest.entries)) fail("Restored attachment identity mismatch");
    await checkDatabase(sandbox, restored);
  } finally {
    // Cleanup is part of success: cleanup failures propagate to the caller.
    await removeCreatedTree(sandbox);
  }
}

export function desktopArguments(names: readonly string[]): Record<string, string> {
  if (process.platform !== "linux" && process.platform !== "win32") fail("Desktop backup requires Linux or Windows with Bun 1.4.2");
  const values: Record<string, string> = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !names.includes(name) || values[name] !== undefined || !value || value.startsWith("--")) fail("Invalid arguments");
    values[name] = value;
  }
  if (names.some((name) => values[name] === undefined)) fail(`Required options: ${names.join(" ")}`);
  process.umask(0o077);
  return values;
}
