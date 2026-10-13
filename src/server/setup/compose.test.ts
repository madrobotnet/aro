import { afterEach, expect, test as platformTest } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Server Compose configuration requires Linux and the external Docker CLI.
const test = platformTest.skipIf(process.platform !== "linux" || !Bun.which("docker"));

const directories: string[] = [];
const root = path.resolve(import.meta.dir, "../../..");
const defaults = {
  SESSION_TTL_DAYS: "30",
  ATTACHMENTS_DIR: "/app/.data/attachments",
  TYPESAFE_API_KEY: "",
  TYPESAFE_JEV_MODEL: "jev-latest",
  TYPESAFE_BASE_URL: "https://api.typesafe.ai",
  CODEX_HOME: "/app/.data/auth/codex",
  CODEX_MODEL: "gpt-6.1-sol",
  CODEX_CHATGPT_BASE_URL: "https://chatgpt.com/backend-api/codex",
  GEMINI_CLI_HOME: "/app/.data/auth/google",
  EMBEDDING_BASE_URL: "",
} as const;
const overrides = {
  SESSION_TTL_DAYS: "7",
  ATTACHMENTS_DIR: "/app/.data/custom-attachments",
  TYPESAFE_API_KEY: "fixture-jev-key",
  TYPESAFE_JEV_MODEL: "~typesafe/jev-latest",
  TYPESAFE_BASE_URL: "https://openrouter.ai/api",
  CODEX_HOME: "/app/.data/custom-codex",
  CODEX_MODEL: "fixture-chat-model",
  CODEX_CHATGPT_BASE_URL: "https://fixture.example/codex",
  GEMINI_CLI_HOME: "/app/.data/custom-google",
  EMBEDDING_BASE_URL: "http://embedding:8080",
} as const;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

for (const scenario of [
  { name: "default", image: "ghcr.io/madrobotnet/aro:2.4.0", values: {}, expected: defaults },
  {
    name: "new image wins over legacy",
    image: "aro:local",
    values: { ARO_IMAGE: "aro:local", IRANG_IMAGE: "legacy:local" },
    expected: defaults,
  },
  {
    name: "operator-provided",
    image: "ghcr.io/example/irang:operator-test",
    values: { IRANG_IMAGE: "ghcr.io/example/irang:operator-test", ...overrides },
    expected: overrides,
  },
]) {
  test(`passes ${scenario.name} runtime settings into the app without database admin secrets`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "second-brain-compose-"));
    directories.push(directory);
    const file = path.join(directory, ".env");
    const values = {
      POSTGRES_PASSWORD: "fixture-app-password",
      POSTGRES_ADMIN_PASSWORD: "fixture-admin-password",
      POSTGRES_APP_DB: "aro",
      POSTGRES_APP_USER: "aro",
      SETUP_TOKEN: "fixture-setup-token-for-compose-configuration",
      UNRELATED_SECRET: "fixture-unrelated-secret",
      ...scenario.values,
    };
    await writeFile(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });

    const child = Bun.spawn(["docker", "compose", "--env-file", file, "-f", "compose.yml", "config", "--format", "json"], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const config: unknown = JSON.parse(stdout);
    expect(config).toMatchObject({
      services: { app: { image: scenario.image, environment: scenario.expected } },
    });
    expect(config).not.toHaveProperty("services.app.build");
    expect(config).not.toHaveProperty("services.app.environment.POSTGRES_ADMIN_PASSWORD");
    expect(config).not.toHaveProperty("services.app.environment.UNRELATED_SECRET");
  });
}

test.each(["POSTGRES_APP_DB", "POSTGRES_APP_USER"])("missing %s fails during Compose configuration", async (missing) => {
  // Given
  const directory = await mkdtemp(path.join(tmpdir(), "aro-compose-"));
  directories.push(directory);
  const file = path.join(directory, ".env");
  const values = { POSTGRES_APP_DB: "aro", POSTGRES_APP_USER: "aro",
    POSTGRES_PASSWORD: "fixture", POSTGRES_ADMIN_PASSWORD: "fixture", SETUP_TOKEN: "fixture" };
  await writeFile(file, Object.entries(values).filter(([key]) => key !== missing)
    .map(([key, value]) => `${key}=${value}`).join("\n"));
  // When
  const child = Bun.spawn(["docker", "compose", "--env-file", file, "-f", "compose.yml", "config", "--format", "json"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then
  expect(code).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain(missing);
});
