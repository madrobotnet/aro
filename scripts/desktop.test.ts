import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateSQLite } from "../src/server/db/sqlite/migrate";
import { SQLITE_MIGRATIONS } from "../src/server/db/sqlite/migrations";
import { mkdtemp, rm, chmod, symlink, realpath, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import argon2 from "argon2";
import { openSQLite } from "../src/server/db/sqlite";
import { desktopDirectory, initializeDesktop } from "./desktop";

const temporaryParent = process.platform === "darwin" ? await realpath(tmpdir()) : tmpdir();

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Desktop process signal timed out")), 60_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function ready(child: ReturnType<typeof launch>): Promise<void> {
  const reader = child.stdout.getReader();
  let output = "";
  try {
    await bounded((async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`Desktop exited before readiness: ${output}`);
        output += new TextDecoder().decode(value);
        if (output.includes("Ready in")) return;
      }
    })());
  } finally { reader.releaseLock(); }
}

function launch(directory: string, port: number) {
  return Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "desktop.ts"),
    "start", "--data-dir", directory, "--port", String(port), "--dev"], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
}

test.skipIf(process.platform !== "linux")("SIGKILLed launcher cannot duplicate a live server and a stale runtime lock recovers", async () => {
  // Given: a real Next server, suspended so parent-death cleanup cannot hide duplicate ownership.
  const directory = await mkdtemp(join(temporaryParent, "aro-desktop-crash-"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const competing = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const competingPort = competing.port;
  competing.stop(true);
  if (!port || !competingPort) throw new Error("No test port");
  let first: ReturnType<typeof launch> | undefined;
  let second: ReturnType<typeof launch> | undefined;
  let recovered: ReturnType<typeof launch> | undefined;
  let cliPid: number | undefined;
  let serverPid: number | undefined;
  try {
    await initializeDesktop(directory, "a-private-test-password");
    first = launch(directory, port);
    await ready(first);
    const children = async (pid: number) => (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/).map(Number);
    [cliPid] = await children(first.pid);
    if (!cliPid) throw new Error("No Next CLI process");
    [serverPid] = await children(cliPid);
    if (!serverPid) throw new Error("No Next server process");
    expect((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(60_000) })).ok).toBe(true);
    process.kill(serverPid, "SIGSTOP");
    // When: the launcher dies without running its cleanup.
    first.kill("SIGKILL");
    await bounded(first.exited);
    second = launch(directory, competingPort);
    const failure = await bounded(new Response(second.stderr).text());
    // Then: the live server, not the launcher, owns the data directory.
    expect(await bounded(second.exited)).toBe(1);
    expect(failure).toContain("database is locked");
    await expect(initializeDesktop(directory, "a-replacement-password")).rejects.toThrow("database is locked");
    // Closing the actual server releases ownership, including after an unclean exit.
    const closed = bounded(first.stdout.pipeTo(new WritableStream()));
    process.kill(serverPid, "SIGKILL");
    serverPid = undefined;
    await closed;
    cliPid = undefined;
    recovered = launch(directory, port);
    await ready(recovered);
    expect((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(60_000) })).ok).toBe(true);
    // Without suspension, EOF also stops the server when its launcher is killed.
    const parentDeath = bounded(recovered.stdout.pipeTo(new WritableStream()));
    recovered.kill("SIGKILL");
    await bounded(recovered.exited);
    await parentDeath;
    using released = new Database(join(directory, "runtime.lock.sqlite"));
    expect(() => released.run("BEGIN IMMEDIATE")).not.toThrow();
  } finally {
    if (serverPid) process.kill(serverPid, "SIGKILL");
    if (cliPid) process.kill(cliPid, "SIGTERM");
    for (const child of [first, second, recovered]) {
      if (child && child.exitCode === null) child.kill("SIGTERM");
      if (child) await bounded(child.exited);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

test("busy runtime ownership prevents startup and initialization from migrating existing data", async () => {
  const directory = await mkdtemp(join(temporaryParent, "aro-desktop-lock-"));
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
  const directory = await mkdtemp(join(temporaryParent, "aro-desktop-init-"));
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
  const directory = await mkdtemp(join(temporaryParent, "aro-desktop-path-"));
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
    await expect(desktopDirectory(join(linked, "child"))).rejects.toThrow();
  } finally {
    await rm(linked, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("Windows default inherited private ACL is accepted", async () => {
  const directory = await mkdtemp(join(temporaryParent, "aro-desktop-acl-"));
  try { expect(await desktopDirectory(directory)).toBe(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
