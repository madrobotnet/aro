#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import argon2 from "argon2";
import { constants, existsSync } from "node:fs";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { openSQLite, sqliteTimestamp } from "../src/server/db/sqlite";
import { startConfiguredModel } from "./model-management";
import { windowsPrivatePath } from "../src/server/desktop/windows-private-path";
import { stopWindowsApp } from "./desktop-process";
import { desktopLock, ownDesktopServer } from "../src/server/desktop/runtime";

const root = resolve(import.meta.dir, "..");

// Preload this same source/bundle, so installed packages need no extra entrypoint.
if (!import.meta.main && process.env.ARO_DESKTOP_PRELOAD) {
  const directory = process.env.ARO_DESKTOP_PRELOAD;
  delete process.env.ARO_DESKTOP_PRELOAD; // Next dev workers get their own runtime lock.
  try { ownDesktopServer(directory); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Desktop runtime unavailable");
    process.exit(1);
  }
}

class DesktopInitializationConflict extends Error {
  readonly code = "conflict";
}

export async function desktopDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error("Use an absolute --data-dir");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (process.platform === "win32") {
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new Error("Data directory must be canonical and free of reparse points");
    }
    await windowsPrivatePath(directory, true);
    return directory;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory ||
      info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("Data directory must be private, owned by this user, and free of symlinks");
  }
  return directory;
}

/** Explicit local initialization, never a network first-owner endpoint. */
export async function initializeDesktop(directory: string, password: string): Promise<void> {
  if (password.length < 12 || password.length > 512) throw new Error("Password must contain 12–512 characters");
  await desktopDirectory(directory);
  using lock = new Database(join(directory, "runtime.lock.sqlite"), { create: true });
  lock.run("PRAGMA busy_timeout=0");
  lock.run("BEGIN IMMEDIATE");
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  using store = openSQLite({ filename: join(directory, "aro.sqlite") });
  // Local bootstrap is independent of Next request state and browser auth.
  store.transaction(q => {
    const occupied = q.get<{ occupied: bigint }>(`SELECT
      EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM installation_settings)
      OR EXISTS(SELECT 1 FROM notes) OR EXISTS(SELECT 1 FROM inbox_items)
      OR EXISTS(SELECT 1 FROM chat_threads) OR EXISTS(SELECT 1 FROM attachments) AS occupied`);
    if (process.env.AUTH_PASSWORD_HASH?.trim() || occupied?.occupied !== 0n) {
      throw new DesktopInitializationConflict("Existing owner or data must not be replaced");
    }
    const now = sqliteTimestamp(new Date());
    const owner = q.get<{ id: string }>(
      "INSERT INTO users(password_hash,created_at,updated_at) VALUES (?,?,?) RETURNING id", [hash, now, now],
    );
    if (!owner) throw new Error("Owner creation returned no identity");
    q.run("INSERT INTO installation_settings(singleton,owner_id,setup_completed,ai,updated_at) VALUES (1,?,1,?,?)",
      [owner.id, JSON.stringify({ version: 2, chatId: null, jevId: null }), now]);
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "init" && command !== "start") {
    throw new Error("Usage: bun scripts/desktop.ts init --data-dir ABSOLUTE --password-stdin | start --data-dir ABSOLUTE [--port 3000] [--dev]");
  }
  let directory: string | undefined;
  let port = 3000;
  let passwordStdin = false;
  let development = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg || seen.has(arg)) throw new Error("Invalid or repeated option");
    seen.add(arg);
    if (arg === "--password-stdin") passwordStdin = true;
    else if (arg === "--dev") development = true;
    else if (arg === "--data-dir") directory = args[++index];
    else if (arg === "--port") port = Number(args[++index]);
    else throw new Error("Unknown option");
  }
  if (!directory || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid data directory or port");
  if (process.platform !== "linux" && process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error("Desktop is supported only on Linux, Windows and macOS");
  }
  if (process.platform === "win32" && development) throw new Error("Windows --dev is unsupported; run bun run build and start without --dev");
  process.umask(0o077);
  if (command === "init") {
    if (!passwordStdin || development || seen.has("--port")) throw new Error("init requires only --data-dir and --password-stdin");
    let password = "";
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        password += decoder.decode(value, { stream: true });
        if (password.length > 1024) throw new Error("Password input is too large");
      }
      password += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    await initializeDesktop(directory, password.replace(/\r?\n$/, ""));
    console.log("Desktop owner created with AI disabled. No installation token is needed.");
    return;
  }
  if (passwordStdin) throw new Error("--password-stdin is only valid for init");
  await desktopDirectory(directory);
  await access(join(directory, "aro.sqlite"), constants.R_OK | constants.W_OK);
  // Always take the entry lock first, so a losing launcher cannot interrupt a
  // winning child's runtime acquisition between preload and instrumentation.
  using server = desktopLock(directory, "server.lock.sqlite");
  using lock = desktopLock(directory);
  {
    using store = openSQLite({ filename: join(directory, "aro.sqlite") });
    if (!store.get("SELECT owner_id FROM installation_settings WHERE singleton=1 AND setup_completed=1")) {
      throw new Error("Initialize the local owner before starting");
    }
  }
  let distDirectory = ".next";
  if (!development && existsSync(join(root, "desktop-release.json"))) {
    const manifest: unknown = JSON.parse(await readFile(join(root, "desktop-release.json"), "utf8"));
    if (!manifest || typeof manifest !== "object" || !("distDirectory" in manifest) ||
        typeof manifest.distDirectory !== "string" || !/^\.next(?:-[a-zA-Z0-9-]+)?$/.test(manifest.distDirectory)) {
      throw new Error("Invalid desktop package manifest");
    }
    distDirectory = manifest.distDirectory;
  }
  if (!development) await access(join(root, distDirectory, "BUILD_ID"), constants.R_OK);
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "LANG", "LC_ALL", "TZ", "TERM",
    ...(process.platform === "win32" ? ["SystemRoot", "SYSTEMROOT", "WINDIR", "USERPROFILE", "TEMP", "TMP"] : [])]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    ARO_DATABASE_MODE: "sqlite", ARO_SQLITE_PATH: join(directory, "aro.sqlite"),
    ATTACHMENTS_DIR: join(directory, "attachments"), INSECURE_COOKIES: "1",
    TRUSTED_PROXY_HOPS: "0", NEXT_TELEMETRY_DISABLED: "1",
    HOSTNAME: "127.0.0.1", PORT: String(port),
    ARO_DESKTOP_DATA_DIR: directory,
    ARO_DESKTOP_PRELOAD: directory,
  });
  const commandLine = !development && existsSync(join(root, "server.js"))
    ? [process.execPath, "--no-env-file", "--preload", import.meta.path, join(root, "server.js")]
    : [process.execPath, "--no-env-file", "--preload", import.meta.path, join(root, "node_modules/next/dist/bin/next"),
      development ? "dev" : "start", ...(development ? ["--webpack"] : []),
      "--hostname", "127.0.0.1", "--port", String(port)];
  const controller = new AbortController();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let model: Awaited<ReturnType<typeof startConfiguredModel>>;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    controller.abort();
    if (child) {
      if (process.platform === "win32") stopping ??= stopWindowsApp(child);
      else child.kill("SIGTERM");
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (process.platform === "win32") process.once("SIGBREAK", stop);
  try {
    try {
      // Local model management remains Linux-only; desktop macOS is lexical-only.
      model = process.platform === "win32" || process.platform === "darwin"
        ? undefined : await startConfiguredModel(directory, controller.signal);
      if (model) env.EMBEDDING_BASE_URL = model.baseURL;
    } catch (error) {
      console.error(`Optional local model unavailable; continuing lexical-only: ${error instanceof Error ? error.message : "startup failed"}`);
    }
    if (controller.signal.aborted) return;
    // Hand ownership to server instrumentation before it opens the app database.
    // Concurrent starts can race here, but only one server can acquire the lock.
    lock.run("ROLLBACK");
    server.run("ROLLBACK");
    child = Bun.spawn(commandLine,
      { cwd: root, env, stdin: "pipe", stdout: "inherit", stderr: "inherit" });
    process.exitCode = await child.exited;
  }
  finally {
    if (process.platform === "win32" && child) {
      await (stopping ??= stopWindowsApp(child));
    }
    await model?.stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (process.platform === "win32") process.off("SIGBREAK", stop);
  }
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Desktop launch failed");
  process.exitCode = 1;
});
