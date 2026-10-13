import { afterEach, expect, test as platformTest } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOCALES } from "@/lib/i18n/locale";
import { readinessCopy } from "@/server/i18n/copy";
import {
  cliCredentialFile, getCliAuthReadiness,
} from "./cli-auth";

// Readiness fixtures exercise the Linux-only official CLI authentication paths.
const test = platformTest.skipIf(process.platform !== "linux");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp("/tmp/cli-auth-test-");
  roots.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const home = path.join(root, "auth");
  await mkdir(path.join(home, ".gemini"), { recursive: true });
  // Presence check must NOT execute this arbitrary binary.
  await symlink(process.execPath, path.join(bin, "gemini"));
  const file = path.join(home, ".gemini/oauth_creds.json");
  const env = { PATH: bin, GEMINI_CLI_HOME: home, CLAUDE_CONFIG_DIR: home };
  return { root, home, file, env };
}

test("reports only file readiness without reading, validating, or refreshing tokens", async () => {
  // Given: deliberately not valid JSON, since this check must not interpret secrets.
  const { file, env } = await setup();
  await writeFile(file, "SECRET-invalid-token");
  // When
  const result = await getCliAuthReadiness("google", { env });
  // Then
  expect(result.provider).toBe("google");
  expect(result.available).toBe(true);
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(await readFile(file, "utf8")).toBe("SECRET-invalid-token");
});

test.each([...LOCALES])("readiness explanation uses the requested %s locale without changing credential access", async (locale) => {
  const { file, env } = await setup();
  await writeFile(file, "SECRET-invalid-token");
  const result = await getCliAuthReadiness("google", { env, locale });
  expect(result.available).toBe(true);
  expect(result.detail).toBe(readinessCopy.cliReady[locale]);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

test("reports missing credentials without scanning HOME", async () => {
  // Given
  const { file, home, env } = await setup();
  await writeFile(file, "SECRET");
  // When
  const result = await getCliAuthReadiness("google", {
    env: { PATH: env.PATH, HOME: home },
  });
  // Then
  expect(result.available).toBe(false);
  expect(JSON.stringify(result)).not.toContain(home);
});

test("rejects credential symlinks escaping the injected credential root", async () => {
  // Given
  const { root, file, env } = await setup();
  const outside = path.join(root, "outside-secret");
  await writeFile(outside, "SECRET");
  await symlink(outside, file);
  // When
  const result = await cliCredentialFile(env);
  // Then
  expect(result).toBeUndefined();
});

test.each(["empty", "directory", "oversized"] as const)("rejects an %s credential source", async (kind) => {
  // Given
  const { file, env } = await setup();
  if (kind === "directory") await mkdir(file);
  else await writeFile(file, kind === "empty" ? "" : "x".repeat(64 * 1024 + 1));
  // When
  const result = await getCliAuthReadiness("google", { env });
  // Then
  expect(result.available).toBe(false);
});

test("does not search relative PATH entries for executable discovery", async () => {
  // Given
  const { env, file } = await setup();
  await writeFile(file, "SECRET");
  // When
  const result = await getCliAuthReadiness("google", { env: { ...env, PATH: ".:relative" } });
  // Then
  expect(result.available).toBe(false);
});
