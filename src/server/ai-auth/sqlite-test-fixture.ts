import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential } from "@/lib/ai-auth";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { sqliteTimestamp } from "@/server/db/sqlite/values";
import type { AiAuthScope } from "./attempt-store";

export const installerToken = "sqlite-ai-installer-fixture-token-at-least-32";
export const browserHash = "b".repeat(64);
export const fixedNow = Date.parse("2026-10-11T12:00:00Z");
const keys = [
  "ARO_DATABASE_MODE", "ARO_SQLITE_PATH", "AUTH_PASSWORD_HASH", "SETUP_TOKEN",
  "TYPESAFE_API_KEY", "CODEX_HOME", "HOME", "DATABASE_URL",
] as const;

export function sqliteAuthFixture(): void {
  let directory: string;
  let environment: Record<string, string | undefined>;
  beforeEach(async () => {
    environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    directory = await mkdtemp(join(tmpdir(), "aro-ai-sqlite-"));
    process.env.ARO_DATABASE_MODE = "sqlite";
    process.env.ARO_SQLITE_PATH = join(directory, "ai.sqlite");
    process.env.SETUP_TOKEN = installerToken;
    process.env.CODEX_HOME = join(directory, "no-ambient-codex");
    process.env.HOME = directory;
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.DATABASE_URL;
  });
  afterEach(async () => {
    await closeSQLiteStore();
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
}

export async function sqliteOwnerScope(): Promise<AiAuthScope> {
  const store = await sqliteStore();
  const owner = store.get<{ id: string }>("INSERT INTO users(password_hash) VALUES ('fixture') RETURNING id");
  if (!owner) throw new Error("Missing fixture owner");
  store.run("INSERT INTO installation_settings(owner_id,setup_completed) VALUES (?,1)", [owner.id]);
  return { key: `owner:${owner.id}`, browserHash };
}

export async function readySQLiteGrant(scope: AiAuthScope, credential: OAuthCredential): Promise<string> {
  const id = crypto.randomUUID();
  (await sqliteStore()).run(
    `INSERT INTO ai_auth_attempts(id,provider,scope_key,browser_hash,status,payload,expires_at)
     VALUES (?,?,?,?,'ready',?,?)`,
    [id, credential.provider, scope.key, scope.browserHash ?? "", JSON.stringify(credential),
      sqliteTimestamp("2099-01-01T00:00:00Z")],
  );
  return id;
}

export function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => handler(String(url), init),
    { preconnect: fetch.preconnect });
}

export async function bounded(signal: Promise<void>): Promise<void> {
  const controller = AbortSignal.timeout(3000);
  await Promise.race([signal, new Promise<never>((_, reject) => {
    controller.addEventListener("abort", () => reject(controller.reason), { once: true });
  })]);
}
