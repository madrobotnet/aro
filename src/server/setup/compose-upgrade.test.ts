import { afterEach, expect, test as platformTest } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// Linux server Compose configuration and its POSIX plugin fixture.
const test = platformTest.skipIf(process.platform !== "linux" || !Bun.which("docker"));

const directories: string[] = [];
const root = path.resolve(import.meta.dir, "../../..");
const modern = {
  POSTGRES_APP_DB: "aro",
  POSTGRES_APP_USER: "aro",
  POSTGRES_PASSWORD: "fixture-current-app-password",
  POSTGRES_ADMIN_PASSWORD: "fixture-current-admin-password",
  SETUP_TOKEN: "fixture-upgrade-installer-token",
};
const legacy = {
  POSTGRES_APP_DB: "second_brain",
  POSTGRES_APP_USER: "second_brain",
  POSTGRES_PASSWORD: "fixture-legacy-admin-password",
  POSTGRES_APP_PASSWORD: "fixture-app#with@reserved:characters",
  DATABASE_URL: "postgres://second_brain:fixture-app%23with%40reserved%3Acharacters@db:5432/second_brain",
  SETUP_TOKEN: modern.SETUP_TOKEN,
  POSTGRES_DATA_VOLUME: "second_brain_pg18",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function compose(values: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), "sb-compose-upgrade-"));
  directories.push(directory);
  const file = path.join(directory, ".env");
  await writeFile(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
  const child = Bun.spawn([
    "docker", "compose", "--env-file", file, "-p", "fixture-upgrade",
    "-f", "compose.yml", "config", "--format", "json",
  ], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("keeps the current installation volume and separated database secrets by default", async () => {
  const result = await compose(modern);
  expect(result.exitCode).toBe(0);
  const config: unknown = JSON.parse(result.stdout);
  expect(config).toMatchObject({
    services: {
      app: { environment: { DATABASE_URL: "postgres://aro:fixture-current-app-password@db:5432/aro" } },
      db: {
        environment: { POSTGRES_PASSWORD: modern.POSTGRES_ADMIN_PASSWORD, POSTGRES_APP_PASSWORD: modern.POSTGRES_PASSWORD },
        volumes: expect.arrayContaining([expect.objectContaining({ type: "volume", source: "postgres-data", target: "/var/lib/postgresql" })]),
      },
    },
    volumes: { "postgres-data": { name: "fixture-upgrade_postgres-data" } },
  });
});

test.each(["POSTGRES_APP_DB", "POSTGRES_APP_USER"])("refuses manual upgrade without %s before resource creation", async (missing) => {
  const result = await compose({ ...legacy, [missing]: "" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(missing);
});

test("mounts the selected legacy database volume instead of creating a new database", async () => {
  const result = await compose({ ...modern, POSTGRES_DATA_VOLUME: "second_brain_pg18" });
  expect(result.exitCode).toBe(0);
  const config: unknown = JSON.parse(result.stdout);
  expect(config).toHaveProperty("services.db.volumes.0.source", "second_brain_pg18");
  expect(config).toHaveProperty("volumes.second_brain_pg18.name", "fixture-upgrade_second_brain_pg18");
});

test("refuses legacy credentials without an explicit data-volume choice", async () => {
  const result = await compose({ ...modern, ...legacy, POSTGRES_DATA_VOLUME: "" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
});

test("still requires a separate admin password for a current installation", async () => {
  const result = await compose({ ...modern, POSTGRES_ADMIN_PASSWORD: "" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
});

test("honors the legacy encoded URL and distinct admin and application passwords", async () => {
  const result = await compose(legacy);
  expect(result.exitCode).toBe(0);
  const config: unknown = JSON.parse(result.stdout);
  expect(config).toMatchObject({ services: {
    app: { environment: { DATABASE_URL: legacy.DATABASE_URL } },
    db: { environment: { POSTGRES_PASSWORD: legacy.POSTGRES_PASSWORD, POSTGRES_APP_PASSWORD: legacy.POSTGRES_APP_PASSWORD } },
  } });
  expect(config).not.toHaveProperty("services.app.environment.POSTGRES_ADMIN_PASSWORD");
  expect(config).not.toHaveProperty("services.app.environment.POSTGRES_APP_PASSWORD");
});

test("keeps an explicitly configured database URL on a current installation", async () => {
  const url = "postgres://fixture:encoded%23password@custom-db:5432/custom";
  const result = await compose({ ...modern, DATABASE_URL: url });
  expect(result.exitCode).toBe(0);
  const config: unknown = JSON.parse(result.stdout);
  expect(config).toHaveProperty("services.app.environment.DATABASE_URL", url);
});

test("smoke isolation keeps the caller's Compose plugin without registry credentials", async () => {
  const callerConfig = process.env.DOCKER_CONFIG ?? path.join(homedir(), ".docker");
  const directory = await mkdtemp(path.join(tmpdir(), "irang-smoke-plugin-"));
  directories.push(directory);
  const ownerConfig = path.join(directory, "owner-docker");
  await mkdir(path.join(ownerConfig, "cli-plugins"), { recursive: true });
  const invoked = path.join(directory, "compose-invoked");
  await writeFile(path.join(ownerConfig, "config.json"), JSON.stringify({
    auths: { "fixture.invalid": { auth: "synthetic-must-not-be-inherited" } },
  }));
  await writeFile(path.join(ownerConfig, "cli-plugins/docker-compose"), `#!/bin/sh
if [ "$1" = docker-cli-plugin-metadata ]; then
  printf '%s\\n' '{"SchemaVersion":"0.1.0","Vendor":"Smoke fixture","Version":"v5.5.1","ShortDescription":"Compose"}'
  exit 0
fi
printf selected > '${invoked}'
shift
exec docker --config '${callerConfig}' compose "$@"
`, { mode: 0o700 });
  const envFile = path.join(directory, ".env");
  await writeFile(envFile, Object.entries(modern).map(([key, value]) => `${key}='${value}'`).join("\n"));
  const source = await readFile(path.join(root, "scripts/smoke-image.mjs"), "utf8");
  // Run the harness's actual environment setup, stopping before image/container work.
  const setup = [
    source.slice(source.indexOf("const environment ="), source.indexOf("async function command(")),
    source.slice(source.indexOf("  temporary = await mkdtemp("), source.indexOf("  const ready =")),
  ].join("\n");
  const child = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file", "-e", `
    import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
    import { homedir } from "node:os";
    import path from "node:path";
    const tmpdir = () => ${JSON.stringify(directory)};
    let temporary;
    ${setup}
    const config = await Bun.file(path.join(environment.DOCKER_CONFIG, "config.json")).json().catch(error => {
      if (error.code !== "ENOENT") throw error;
      return {};
    });
    console.error(JSON.stringify(config));
    const compose = Bun.spawn(["docker", "compose", "--env-file", ${JSON.stringify(envFile)},
      "-f", "compose.yml", "config", "--format", "json"], { env: environment, stdout: "inherit", stderr: "inherit" });
    process.exitCode = await compose.exited;
  `], {
    cwd: root, env: { PATH: process.env.PATH, HOME: directory, DOCKER_CONFIG: ownerConfig },
    stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(await Bun.file(invoked).exists()).toBe(true);
  expect(JSON.parse(stderr)).toEqual({ cliPluginsExtraDirs: [path.join(ownerConfig, "cli-plugins")] });
  expect(JSON.parse(stdout)).toHaveProperty("services.db.volumes.0.source", "postgres-data");
});
