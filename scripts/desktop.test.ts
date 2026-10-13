import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateSQLite } from "../src/server/db/sqlite/migrate";
import { SQLITE_MIGRATIONS } from "../src/server/db/sqlite/migrations";
import { mkdtemp, rm, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import argon2 from "argon2";
import { openSQLite } from "../src/server/db/sqlite";
import { desktopDirectory, initializeDesktop } from "./desktop";

test("busy runtime ownership prevents startup and initialization from migrating existing data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-desktop-lock-"));
  try {
    using db = new Database(join(directory, "aro.sqlite"));
    db.run("PRAGMA foreign_keys=ON");
    migrateSQLite(db, SQLITE_MIGRATIONS.slice(0, 2));
    db.run("INSERT INTO notes(title,body) VALUES ('Preserved','original')");
    const history = db.query("SELECT * FROM aro_schema_migrations").all();
    using lock = new Database(join(directory, "runtime.lock.sqlite"));
    lock.run("BEGIN IMMEDIATE");
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "desktop.ts"),
      "start", "--data-dir", directory], {
      env: { ...process.env, AUTH_PASSWORD_HASH: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(stderr).toContain("database is locked");
    await expect(initializeDesktop(directory, "a-private-test-password")).rejects.toThrow("database is locked");
    expect(db.query("SELECT * FROM aro_schema_migrations").all()).toEqual(history);
    expect(db.query("SELECT title,body FROM notes").all()).toEqual([{ title: "Preserved", body: "original" }]);
    lock.run("ROLLBACK");
    using upgraded = openSQLite({ filename: join(directory, "aro.sqlite") });
    expect(upgraded.get("SELECT count(*) AS n FROM aro_schema_migrations")).toEqual({ n: BigInt(SQLITE_MIGRATIONS.length) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local initialization creates one owner with AI off and never overwrites it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-desktop-init-"));
  try {
    await initializeDesktop(directory, "a-private-test-password");
    using store = openSQLite({ filename: join(directory, "aro.sqlite") });
    const owner = store.get<{ password_hash: string }>("SELECT password_hash FROM users");
    if (!owner) throw new Error("No owner created");
    expect(await argon2.verify(owner.password_hash, "a-private-test-password")).toBe(true);
    expect(store.get<{ ai: string }>("SELECT ai FROM installation_settings")?.ai)
      .toBe(JSON.stringify({ version: 2, chatId: null, jevId: null }));
    await expect(initializeDesktop(directory, "a-replacement-password")).rejects.toMatchObject({ code: "conflict" });
    expect(store.get<{ count: bigint }>("SELECT count(*) AS count FROM users")?.count).toBe(1n);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsafe directory and short password fail before owner creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-desktop-path-"));
  const linked = `${directory}-link`;
  try {
    await expect(initializeDesktop(directory, "short")).rejects.toThrow();
    if (process.platform === "win32") {
      const child = Bun.spawn(["icacls", directory, "/grant", "*S-1-5-32-545:(OI)(CI)M"],
        { stdout: "ignore", stderr: "ignore" });
      expect(await child.exited).toBe(0);
    } else await chmod(directory, 0o755);
    await expect(desktopDirectory(directory)).rejects.toThrow();
    if (process.platform !== "win32") await chmod(directory, 0o700);
    await symlink(directory, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(desktopDirectory(linked)).rejects.toThrow();
  } finally {
    await rm(linked, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("Windows default inherited private ACL is accepted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-desktop-acl-"));
  try { expect(await desktopDirectory(directory)).toBe(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
