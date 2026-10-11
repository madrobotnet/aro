import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import argon2 from "argon2";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiSettingsInput } from "@/lib/ai-settings";
import { POST as setupPost } from "@/app/api/setup/route";
import { verifyLogin } from "@/server/auth/lockout";
import { createSession, revokeAllSessions, revokeToken, sessionFromToken } from "@/server/auth/session";
import { recordSQLiteLogin, sqliteLoginLock } from "@/server/auth/sqlite-lockout";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { openSQLite, sqliteTimestamp } from "@/server/db/sqlite";
import { requireInstallerAccess } from "./access";
import { completeSetup, loginPasswordHash, setupState } from "./service";
import { completeSQLiteSetup } from "./sqlite";

const token = "sqlite-installer-token-with-at-least-32-characters";
const password = "sqlite-owner-long-password";
const ai: AiSettingsInput = { chat: null, chatConsent: false, jev: null, jevConsent: false };
const keys = ["ARO_DATABASE_MODE", "ARO_SQLITE_PATH", "AUTH_PASSWORD_HASH", "SETUP_TOKEN"] as const;
let environment: Record<string, string | undefined>;
let directory: string;
let hash: string;

beforeAll(async () => {
  hash = await argon2.hash(password, { type: argon2.argon2id });
});
beforeEach(async () => {
  environment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  directory = await mkdtemp(join(tmpdir(), "aro-auth-sqlite-"));
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "auth.sqlite");
  process.env.SETUP_TOKEN = token;
  delete process.env.AUTH_PASSWORD_HASH;
});
afterEach(async () => {
  await closeSQLiteStore();
  await rm(directory, { recursive: true, force: true });
  for (const key of keys) {
    const value = environment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("AI-off bootstrap persists a usable owner through reopen and login", async () => {
  expect(await setupState()).toBe("ready");
  await completeSetup({ setupToken: token, password, ai });
  await closeSQLiteStore();
  const saved = await loginPasswordHash();
  if (saved === null) throw new Error("Missing setup password");
  expect(await verifyLogin({ clientKey: "owner", password, hash: saved })).toEqual({ kind: "accepted" });
  const session = await createSession({ passwordHash: saved, userAgent: "sqlite-test", ip: "127.0.0.1" });
  const authenticated = await sessionFromToken(session.token);
  expect(authenticated?.expiresAt).toBe(session.expiresAt.toISOString());
  expect(await setupState()).toBe("complete");
  const store = await sqliteStore();
  expect(store.get<{ ai: string }>("SELECT ai FROM installation_settings")?.ai)
    .toBe(JSON.stringify({ version: 2, chatId: null, jevId: null }));
  expect(store.get<{ user_id: string }>("SELECT user_id FROM sessions")?.user_id).toBe(authenticated?.userId);
  expect(store.get<{ token_hash: Uint8Array }>("SELECT token_hash FROM sessions")?.token_hash.byteLength).toBe(32);
});

test("concurrent bootstrap commits exactly one owner and settings document", async () => {
  const results = await Promise.allSettled(Array.from({ length: 4 }, () =>
    completeSetup({ setupToken: token, password, ai }),
  ));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  for (const result of results) {
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "conflict" });
  }
  const store = await sqliteStore();
  expect(store.all("SELECT id FROM users")).toHaveLength(1);
  expect(store.all("SELECT owner_id FROM installation_settings")).toHaveLength(1);
});

test("setup HTTP handler preserves the success DTO and rejects a repeated bootstrap", async () => {
  const request = () => new Request("http://localhost/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupToken: token, password, passwordConfirmation: password, ai }),
  });
  const created = await setupPost(request(), {});
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ ok: true });
  const repeated = await setupPost(request(), {});
  expect(repeated.status).toBe(409);
  expect((await repeated.json()).error.code).toBe("conflict");
});

test("bootstrap rechecks protected data inserted after initial installer authorization", async () => {
  const scope = await requireInstallerAccess(token);
  const store = await sqliteStore();
  using other = openSQLite({ filename: join(directory, "auth.sqlite"), busyTimeoutMs: 0 });
  other.run("INSERT INTO notes (title, body) VALUES ('raced', 'protected')");
  expect(() => completeSQLiteSetup(store, hash, scope)).toThrow();
  expect(store.all("SELECT id FROM users")).toHaveLength(0);
  expect(store.all("SELECT owner_id FROM installation_settings")).toHaveLength(0);
});

test("incomplete installation settings protect their owner without enabling wizard login", async () => {
  const store = await sqliteStore();
  const owner = store.get<{ id: string }>("INSERT INTO users (password_hash) VALUES (?) RETURNING id", [hash]);
  if (!owner) throw new Error("Missing fixture owner");
  store.run("INSERT INTO installation_settings (owner_id) VALUES (?)", [owner.id]);
  expect(await setupState()).toBe("complete");
  expect(await loginPasswordHash()).toBeNull();
  await expect(completeSetup({ setupToken: token, password, ai })).rejects.toMatchObject({ code: "conflict" });
});

test("concurrent legacy logins reuse one owner and create distinct sessions", async () => {
  const sessions = await Promise.all(Array.from({ length: 8 }, () =>
    createSession({ passwordHash: hash, userAgent: null, ip: null }),
  ));
  const store = await sqliteStore();
  expect(store.all("SELECT id FROM users")).toHaveLength(1);
  expect(store.all("SELECT id FROM sessions")).toHaveLength(8);
  expect(new Set(sessions.map((session) => session.token)).size).toBe(8);
  expect(await loginPasswordHash()).toBeNull();
  expect(await setupState()).toBe("complete");
});

test("logout revocation invalidates only its token and global revocation counts remaining sessions", async () => {
  const input = { passwordHash: hash, userAgent: null, ip: null };
  const first = await createSession(input);
  const second = await createSession(input);
  await revokeToken(first.token);
  expect(await sessionFromToken(first.token)).toBeNull();
  expect(await sessionFromToken(second.token)).not.toBeNull();
  expect(await revokeAllSessions()).toBe(1);
  expect(await sessionFromToken(second.token)).toBeNull();
  expect(await revokeAllSessions()).toBe(0);
});

test("expired and unknown tokens cannot authenticate or update last-seen time", async () => {
  const session = await createSession({ passwordHash: hash, userAgent: null, ip: null });
  const store = await sqliteStore();
  store.run("UPDATE sessions SET expires_at = ?, last_seen_at = NULL",
    [sqliteTimestamp("2000-01-01T00:00:00Z")]);
  expect(await sessionFromToken(session.token)).toBeNull();
  expect(await sessionFromToken("unknown")).toBeNull();
  expect(store.get<{ last_seen_at: string | null }>("SELECT last_seen_at FROM sessions")?.last_seen_at).toBeNull();
});

test("session IP validation fails before owner creation and normalizes IPv6", async () => {
  await expect(createSession({ passwordHash: hash, userAgent: null, ip: "invalid" })).rejects.toThrow(TypeError);
  const store = await sqliteStore();
  expect(store.all("SELECT id FROM users")).toHaveLength(0);
  await createSession({ passwordHash: hash, userAgent: null, ip: "2001:0db8:0:0:0:0:0:1" });
  expect(store.get<{ ip: string }>("SELECT ip FROM sessions")?.ip).toBe("2001:db8::1");
});

test("concurrent bad passwords persist exactly five failures", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    verifyLogin({ clientKey: "concurrent", password: "wrong", hash }),
  ));
  expect(results.filter((result) => result.kind === "wrong_password")).toHaveLength(4);
  expect(results.filter((result) => result.kind === "locked")).toHaveLength(4);
  const store = await sqliteStore();
  expect(store.all("SELECT attempted_at FROM auth_login_failures")).toHaveLength(5);
  expect((await verifyLogin({ clientKey: "concurrent", password, hash })).kind).toBe("locked");
  expect(store.all("SELECT attempted_at FROM auth_login_failures")).toHaveLength(5);
});

test("successful login clears only its client while malformed hashes do not write failures", async () => {
  const store = await sqliteStore();
  for (const client of ["owner", "other"]) {
    store.run("INSERT INTO auth_login_failures (client_key) VALUES (?)", [client]);
  }
  expect(await verifyLogin({ clientKey: "owner", password, hash })).toEqual({ kind: "accepted" });
  expect(store.all("SELECT client_key FROM auth_login_failures")).toEqual([{ client_key: "other" }]);
  await expect(verifyLogin({ clientKey: "invalid", password, hash: "malformed" })).rejects.toThrow();
  expect(store.all("SELECT client_key FROM auth_login_failures")).toEqual([{ client_key: "other" }]);
});

test("lockout expiry, retry delay, and cleanup use deterministic instants", async () => {
  const store = await sqliteStore();
  const now = Date.parse("2026-01-01T12:00:00Z");
  store.run("INSERT INTO auth_login_failures VALUES (?, ?)",
    ["old", sqliteTimestamp(new Date(now - 86_400_001))]);
  for (let index = 0; index < 5; index++) {
    store.transaction((executor) => recordSQLiteLogin(executor, "locked", false, now));
  }
  expect(sqliteLoginLock(store, "locked", now + 1000)).toEqual({ kind: "locked", retryAfterSeconds: 899 });
  expect(store.all("SELECT client_key FROM auth_login_failures WHERE client_key = 'old'")).toHaveLength(0);
  expect(sqliteLoginLock(store, "locked", now + 900_000)).toBeNull();
  expect(store.transaction((executor) => recordSQLiteLogin(executor, "locked", true, now + 900_000)))
    .toEqual({ kind: "accepted" });
  expect(store.all("SELECT client_key FROM auth_login_failures")).toHaveLength(0);
});

test("a second connection's failures are rechecked after password verification", async () => {
  const store = await sqliteStore();
  using other = openSQLite({ filename: join(directory, "auth.sqlite"), busyTimeoutMs: 0 });
  const now = Date.parse("2026-01-01T12:00:00Z");
  expect(sqliteLoginLock(store, "owner", now)).toBeNull();
  for (let index = 0; index < 5; index++) {
    other.transaction((executor) => recordSQLiteLogin(executor, "owner", false, now));
  }
  expect(store.transaction((executor) => recordSQLiteLogin(executor, "owner", true, now)))
    .toEqual({ kind: "locked", retryAfterSeconds: 900 });
  expect(store.all("SELECT client_key FROM auth_login_failures")).toHaveLength(5);
});

test("installer authorization requires the configured matching token", async () => {
  delete process.env.SETUP_TOKEN;
  expect(await setupState()).toBe("disabled");
  await expect(completeSetup({ setupToken: token, password, ai })).rejects.toMatchObject({ code: "unavailable" });
  process.env.SETUP_TOKEN = token;
  await expect(requireInstallerAccess("wrong")).rejects.toMatchObject({ code: "forbidden" });
  expect((await sqliteStore()).all("SELECT id FROM users")).toHaveLength(0);
});

for (const statement of [
  "INSERT INTO users (password_hash) VALUES ('legacy')",
  "INSERT INTO notes (title, body) VALUES ('protected', 'body')",
  "INSERT INTO inbox_items (title, source) VALUES ('protected', 'manual')",
  "INSERT INTO chat_threads (title) VALUES ('protected')",
  "INSERT INTO attachments (storage_key, filename, mime, size_bytes) VALUES ('key', 'file', 'text/plain', 1)",
]) {
  test(`existing data blocks bootstrap: ${statement.split(" ")[2]}`, async () => {
    const store = await sqliteStore();
    store.run(statement);
    expect(await setupState()).toBe("complete");
    expect(await loginPasswordHash()).toBeNull();
    await expect(completeSetup({ setupToken: token, password, ai })).rejects.toMatchObject({ code: "conflict" });
    expect(store.all("SELECT owner_id FROM installation_settings")).toHaveLength(0);
  });
}

test("environment password remains authoritative and prevents bootstrap", async () => {
  process.env.AUTH_PASSWORD_HASH = hash;
  expect(await loginPasswordHash()).toBe(hash);
  expect(await setupState()).toBe("complete");
  await expect(completeSetup({ setupToken: token, password, ai })).rejects.toMatchObject({ code: "conflict" });
  expect((await sqliteStore()).all("SELECT id FROM users")).toHaveLength(0);
});

test("configured AI persists during bootstrap and clears unused setup grants", async () => {
  const store = await sqliteStore();
  store.run(`INSERT INTO ai_auth_attempts
    (id, provider, scope_key, browser_hash, status, payload, expires_at)
    VALUES (?, 'openrouter', ?, ?, 'ready', ?, ?)`,
  ["11111111-1111-4111-8111-111111111111", await requireInstallerAccess(token), "browser",
    '{"secret":"fixture"}', sqliteTimestamp("2099-01-01T00:00:00Z")]);
  await completeSetup({ setupToken: token, password, ai: {
    ...ai, chat: { mode: "api", provider: "openai", model: "fixture", apiKey: "fixture-secret" },
    chatConsent: true, jev: { mode: "environment" }, jevConsent: true,
  } });
  expect(store.all("SELECT id FROM users")).toHaveLength(1);
  expect(store.all("SELECT owner_id FROM installation_settings")).toHaveLength(1);
  expect(JSON.parse(store.get<{ connection: string }>("SELECT connection FROM ai_connections")?.connection ?? "{}"))
    .toMatchObject({ apiKey: "fixture-secret", model: "fixture" });
  expect(JSON.parse(store.get<{ ai: string }>("SELECT ai FROM installation_settings")?.ai ?? "{}").jevId)
    .toBe("environment");
  expect(store.all("SELECT id FROM ai_auth_attempts")).toHaveLength(0);
});

test("failed settings insertion rolls back owner creation and leaves setup retryable", async () => {
  const store = await sqliteStore();
  using connection = new Database(join(directory, "auth.sqlite"));
  connection.run(`CREATE TRIGGER fail_setup BEFORE INSERT ON installation_settings
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  await expect(completeSetup({ setupToken: token, password, ai })).rejects.toThrow("fixture failure");
  expect(store.all("SELECT id FROM users")).toHaveLength(0);
  expect(await setupState()).toBe("ready");
});
