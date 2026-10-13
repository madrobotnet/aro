import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openSQLite } from "../src/server/db/sqlite";
import { backupDesktop, hashOrCopy, verifyDesktopBackup } from "./backup-desktop-common";

const roots: string[] = [];
const canonicalTemporaryParent = process.platform === "darwin" ? await realpath(tmpdir()) : tmpdir();
const key = process.platform === "win32"
  ? "10000000-0000-4000-8000-000000000001-legacy-name"
  : "10000000-0000-4000-8000-000000000001-legacy\\name";
const noteId = "20000000-0000-4000-8000-000000000001";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Fixtures may deliberately retain read-only attachment directories.
    const writable = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      await chmod(path, 0o700);
      for (const name of await readdir(path)) await writable(join(path, name));
    };
    await writable(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(canonicalTemporaryParent, "aro-backup-test-"));
  roots.push(root);
  const data = join(root, "desktop");
  const backup = join(root, "backup");
  const temporaryParent = join(root, "sandboxes");
  await mkdir(data, { mode: 0o700 });
  await mkdir(temporaryParent, { mode: 0o700 });
  await mkdir(join(data, "attachments"), { mode: 0o700 });
  {
    using db = openSQLite({ filename: join(data, "aro.sqlite") });
    db.run("INSERT INTO users(password_hash) VALUES (?)", ["private-test-hash"]);
    db.run("INSERT INTO notes(id,title,body,tags,aliases) VALUES (?,'A note','original body','[\"tag\"]','[\"alias\"]')", [noteId]);
    db.run("INSERT INTO note_revisions(note_id,title,body) VALUES (?,'Before','old body')", [noteId]);
    db.run("INSERT INTO attachments(note_id,filename,mime,size_bytes,storage_key) VALUES (?,'legacy','application/octet-stream',4,?)", [noteId, key]);
  }
  await chmod(join(data, "aro.sqlite"), 0o600);
  await writeFile(join(data, "attachments", key), new Uint8Array([0, 255, 1, 2]), { mode: 0o640 });
  // Creation mode is masked by the test process umask; establish the fixture explicitly.
  await chmod(join(data, "attachments", key), 0o640);
  return { root, data, backup, temporaryParent };
}

const testManifestSchema = z.object({
  entries: z.array(z.object({
    kind: z.enum(["file", "directory"]), path: z.string(), mode: z.number().optional(),
    size: z.number().optional(), sha256: z.string().optional(),
  }).passthrough()),
}).passthrough();

async function manifest(backup: string) {
  return testManifestSchema.parse(JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")));
}

async function rehashDatabase(backup: string) {
  const value = await manifest(backup);
  const entry = value.entries.find((entry) => entry.path === "aro.sqlite");
  if (!entry) throw new Error("Missing fixture database entry");
  Object.assign(entry, await hashOrCopy(join(backup, "aro.sqlite")));
  await writeFile(join(backup, "manifest.json"), JSON.stringify(value));
}

test("preserves real SQLite rows all attachment bytes permissions and excludes transient locks", async () => {
  const f = await fixture();
  const large = Buffer.alloc(3 * 1024 * 1024 + 31, 197);
  await writeFile(join(f.data, "attachments", "unreferenced"), large, { mode: 0o400 });
  await mkdir(join(f.data, "attachments", "empty"), { mode: 0o500 });
  await chmod(join(f.data, "attachments"), 0o750);
  await writeFile(join(f.data, "thread.lock.sqlite"), "transient");
  await backupDesktop(f.data, f.backup);
  using restored = new Database(join(f.backup, "aro.sqlite"), { readonly: true });
  expect(restored.query("SELECT title,body,tags,aliases FROM notes").get()).toEqual({
    title: "A note", body: "original body", tags: '["tag"]', aliases: '["alias"]',
  });
  expect(restored.query("SELECT password_hash FROM users").get()).toEqual({ password_hash: "private-test-hash" });
  expect(restored.query("SELECT title,body FROM note_revisions").get()).toEqual({ title: "Before", body: "old body" });
  expect(restored.query("SELECT storage_key,size_bytes FROM attachments").get()).toEqual({ storage_key: key, size_bytes: 4 });
  expect(await readFile(join(f.backup, "attachments", key))).toEqual(Buffer.from([0, 255, 1, 2]));
  expect(await readFile(join(f.backup, "attachments", "unreferenced"))).toEqual(large);
  if (process.platform === "win32") {
    const value = await manifest(f.backup);
    expect(value).toMatchObject({ version: 2, platform: "win32", permissionModel: "windows-acl" });
    expect(value).not.toHaveProperty("dataDirectoryMode");
    expect(value.entries.every(entry => !("mode" in entry))).toBe(true);
  } else {
    expect((await lstat(join(f.backup, "attachments"))).mode & 0o777).toBe(0o750);
    expect((await lstat(join(f.backup, "attachments", key))).mode & 0o777).toBe(0o640);
    expect((await lstat(join(f.backup, "attachments", "empty"))).mode & 0o777).toBe(0o500);
    expect((await lstat(join(f.backup, "aro.sqlite"))).mode & 0o777).toBe(0o600);
    expect((await manifest(f.backup)).version).toBe(1);
  }
  expect((await readdir(f.backup)).sort()).toEqual(["aro.sqlite", "attachments", "manifest.json"]);
  const lockBefore = await lstat(join(f.data, "runtime.lock.sqlite"));
  await verifyDesktopBackup(f.backup, f.temporaryParent);
  expect(await readdir(f.temporaryParent)).toEqual([]);
  expect((await lstat(join(f.data, "runtime.lock.sqlite"))).ino).toBe(lockBefore.ino);
});

test("native snapshot contains committed WAL pages without copying sidecars", async () => {
  const f = await fixture();
  using writer = new Database(join(f.data, "aro.sqlite"));
  writer.run("PRAGMA journal_mode=WAL");
  writer.run("PRAGMA wal_autocheckpoint=0");
  writer.run("UPDATE notes SET body='committed in WAL'");
  expect((await lstat(join(f.data, "aro.sqlite-wal"))).size).toBeGreaterThan(0);
  await backupDesktop(f.data, f.backup);
  using restored = new Database(join(f.backup, "aro.sqlite"), { readonly: true });
  expect(restored.query("SELECT body FROM notes").get()).toEqual({ body: "committed in WAL" });
  expect(await readdir(f.backup)).not.toContain("aro.sqlite-wal");
  await verifyDesktopBackup(f.backup, f.temporaryParent);
});

test("refuses immediately while launcher BEGIN IMMEDIATE lock is held and retains its inode", async () => {
  const f = await fixture();
  const lockPath = join(f.data, "runtime.lock.sqlite");
  using launcher = new Database(lockPath, { create: true });
  launcher.run("BEGIN IMMEDIATE");
  const before = await lstat(lockPath);
  try {
    await expect(backupDesktop(f.data, f.backup)).rejects.toThrow("launcher lock");
    expect(await readdir(f.root)).not.toContain("backup");
    expect((await lstat(lockPath)).ino).toBe(before.ino);
  } finally { launcher.run("ROLLBACK"); }
});

test("never overwrites even an empty existing output", async () => {
  const f = await fixture();
  await mkdir(f.backup, { mode: 0o700 });
  await expect(backupDesktop(f.data, f.backup)).rejects.toThrow("already exists");
  expect(await readdir(f.backup)).toEqual([]);
});

async function makeShared(directory: string) {
  if (process.platform === "win32") {
    const child = Bun.spawn(["icacls", directory, "/grant", "*S-1-5-32-545:(OI)(CI)M"],
      { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
  } else await chmod(directory, 0o755);
}

test("refuses outputs within source and nonprivate output parents", async () => {
  const f = await fixture();
  await expect(backupDesktop(f.data, join(f.data, "backup"))).rejects.toThrow("outside");
  await makeShared(f.temporaryParent);
  await expect(backupDesktop(f.data, join(f.temporaryParent, "backup"))).rejects.toThrow("private");
});

test("refuses nonprivate source directories", async () => {
  const f = await fixture();
  await makeShared(f.data);
  await expect(backupDesktop(f.data, f.backup)).rejects.toThrow("private");
});

test.each(["data", "database", "attachments", "wal", "runtime", "ancestor", "output"])(
  "refuses a symlink at %s without creating a completed backup", async (location) => {
    const f = await fixture();
    let data = f.data;
    let output = f.backup;
    switch (location) {
      case "data":
        data = join(f.root, "linked-data");
        await symlink(f.data, data);
        break;
      case "database": {
        const bytes = await readFile(join(f.data, "aro.sqlite"));
        const target = join(f.root, "database");
        await writeFile(target, bytes);
        await rm(join(f.data, "aro.sqlite"));
        await symlink(target, join(f.data, "aro.sqlite"));
        break;
      }
      case "attachments":
        await symlink(join(f.data, "attachments", key), join(f.data, "attachments", "linked"));
        break;
      case "wal":
        await symlink(join(f.data, "aro.sqlite"), join(f.data, "aro.sqlite-wal"));
        break;
      case "runtime":
        await symlink(join(f.data, "aro.sqlite"), join(f.data, "runtime.lock.sqlite"));
        break;
      case "ancestor": {
        const ancestor = join(f.root, "linked-root");
        await symlink(f.root, ancestor);
        data = join(ancestor, "desktop");
        break;
      }
      case "output":
        output = join(f.root, "linked-output");
        await symlink(f.temporaryParent, output);
        break;
    }
    await expect(backupDesktop(data, output)).rejects.toThrow();
    expect(await readdir(f.root)).not.toContain("backup");
    expect(await readFile(join(f.data, "attachments", key))).toEqual(Buffer.from([0, 255, 1, 2]));
  },
);

test("failed copy after copied files cleans partial output with no completed manifest", async () => {
  const f = await fixture();
  await writeFile(join(f.data, "attachments", "000-copied-first"), "copied");
  await symlink(join(f.data, "attachments", key), join(f.data, "attachments", "zzz-refused"));
  await expect(backupDesktop(f.data, f.backup)).rejects.toThrow();
  expect(await readdir(f.root)).not.toContain("backup");
  using lock = new Database(join(f.data, "runtime.lock.sqlite"));
  lock.run("PRAGMA busy_timeout=0");
  lock.run("BEGIN IMMEDIATE");
  lock.run("ROLLBACK");
});

for (const corruption of ["bytes", "mode", "extra-file", "missing-file", "link"]) {
  test.skipIf(process.platform === "win32" && corruption === "mode")(
  `verification refuses ${corruption} before sandbox creation`, async () => {
    const f = await fixture();
    await backupDesktop(f.data, f.backup);
    const attachment = join(f.backup, "attachments", key);
    switch (corruption) {
      case "bytes": await writeFile(attachment, Buffer.from([0, 255, 1, 3])); break;
      case "mode": await chmod(attachment, 0o600); break;
      case "extra-file": await writeFile(join(f.backup, "attachments", "extra"), "extra"); break;
      case "missing-file": await rm(attachment); break;
      case "link":
        await rm(attachment);
        await symlink(join(f.data, "attachments", key), attachment);
        break;
    }
    await expect(verifyDesktopBackup(f.backup, f.temporaryParent)).rejects.toThrow();
    expect(await readdir(f.temporaryParent)).toEqual([]);
  },
);
}

test.each(["traversal", "absolute", "duplicate", "version", "parent", "root-mode", "invalid-json"])(
  "verification refuses manifest %s", async (corruption) => {
    const f = await fixture();
    await backupDesktop(f.data, f.backup);
    const value = await manifest(f.backup);
    const first = value.entries[0];
    if (!first) throw new Error("Empty fixture manifest");
    switch (corruption) {
      case "traversal": first.path = "attachments/../../escape"; break;
      case "absolute": first.path = "/escape"; break;
      case "duplicate": value.entries.push(first); break;
      case "version": value.version = 999; break;
      case "root-mode": value.dataDirectoryMode = 0; break;
      case "parent": value.entries.push({ kind: "file", path: "attachments/missing/file", mode: 0o600, size: 0, sha256: "0".repeat(64) }); break;
      case "invalid-json": break;
    }
    await writeFile(join(f.backup, "manifest.json"), corruption === "invalid-json" ? "{" : JSON.stringify(value));
    await expect(verifyDesktopBackup(f.backup, f.temporaryParent)).rejects.toThrow();
    expect(await readdir(f.temporaryParent)).toEqual([]);
    expect(await readdir(f.root)).not.toContain("escape");
  },
);

test.each(["missing-attachment", "foreign-key", "invalid-sqlite"])(
  "restored database %s failure removes its sandbox even after checksum validation", async (corruption) => {
    const f = await fixture();
    await backupDesktop(f.data, f.backup);
    const filename = join(f.backup, "aro.sqlite");
    if (corruption === "invalid-sqlite") await writeFile(filename, "not a SQLite database");
    else {
      using db = new Database(filename);
      db.run("PRAGMA journal_mode=DELETE");
      if (corruption === "foreign-key") db.run("UPDATE attachments SET note_id='missing-note'");
      else db.run("UPDATE attachments SET storage_key='missing-file'");
    }
    await rehashDatabase(f.backup);
    const before = (await hashOrCopy(join(f.data, "aro.sqlite"))).sha256;
    await expect(verifyDesktopBackup(f.backup, f.temporaryParent)).rejects.toThrow();
    expect(await readdir(f.temporaryParent)).toEqual([]);
    expect((await hashOrCopy(join(f.data, "aro.sqlite"))).sha256).toBe(before);
  },
);

test("verification rejects symlinked manifest or sandbox parent", async () => {
  const f = await fixture();
  await backupDesktop(f.data, f.backup);
  const linked = join(f.root, "linked-sandboxes");
  await symlink(f.temporaryParent, linked);
  await expect(verifyDesktopBackup(f.backup, linked)).rejects.toThrow();
  const original = await readFile(join(f.backup, "manifest.json"));
  await writeFile(join(f.root, "manifest-copy"), original);
  await rm(join(f.backup, "manifest.json"));
  await symlink(join(f.root, "manifest-copy"), join(f.backup, "manifest.json"));
  await expect(verifyDesktopBackup(f.backup, f.temporaryParent)).rejects.toThrow();
  expect(await readdir(f.temporaryParent)).toEqual([]);
});

test.skipIf(process.platform === "win32")("refuses source ownership mismatch", async () => {
  const f = await fixture();
  // Root-only ownership fixture is deterministic; ordinary users test a root-owned directory.
  if (process.getuid?.() === 0) {
    await chown(f.data, 65534, 65534);
    try { await expect(backupDesktop(f.data, f.backup)).rejects.toThrow("owned"); }
    finally { await chown(f.data, 0, 0); }
  } else {
    await expect(backupDesktop("/", f.backup)).rejects.toThrow("owned");
  }
  expect(await readdir(f.root)).not.toContain("backup");
});

test("refuses other platform backup format before sandbox writes", async () => {
  const f = await fixture();
  await backupDesktop(f.data, f.backup);
  const value = await manifest(f.backup);
  value.version = process.platform === "win32" ? 1 : 2;
  await writeFile(join(f.backup, "manifest.json"), JSON.stringify(value));
  await expect(verifyDesktopBackup(f.backup, f.temporaryParent)).rejects.toMatchObject({ code: "platform-mismatch" });
  expect(await readdir(f.temporaryParent)).toEqual([]);
});

test.skipIf(process.platform !== "win32")("Windows backup rejects POSIX entry modes as malformed", async () => {
  const f = await fixture();
  await backupDesktop(f.data, f.backup);
  const value = await manifest(f.backup);
  const first = value.entries[0];
  if (!first) throw new Error("Missing inventory");
  first.mode = 0o600;
  await writeFile(join(f.backup, "manifest.json"), JSON.stringify(value));
  await expect(verifyDesktopBackup(f.backup, f.temporaryParent)).rejects.toThrow();
  expect(await readdir(f.temporaryParent)).toEqual([]);
});

test("backs up installations with no attachment directory when there are no attachment rows", async () => {
  const f = await fixture();
  {
    using db = new Database(join(f.data, "aro.sqlite"));
    db.run("DELETE FROM attachments");
  }
  await rm(join(f.data, "attachments"), { recursive: true });
  await backupDesktop(f.data, f.backup);
  await verifyDesktopBackup(f.backup, f.temporaryParent);
  expect((await readdir(f.backup)).sort()).toEqual(["aro.sqlite", "manifest.json"]);
  expect(await readdir(f.temporaryParent)).toEqual([]);
});
