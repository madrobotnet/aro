#!/usr/bin/env bun
// Maintainer QA: synthetic data only. Never point this at an existing project.
import { mkdtemp, mkdir, cp, readFile, writeFile, stat, rm, chmod } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function options(args) {
  const result = {};
  const allowed = ["image", "project", "port", "evidence-dir", "install-dir"];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    check(args[i]?.startsWith("--") && allowed.includes(key), "Unknown option");
    check(!Object.hasOwn(result, key), "Duplicate option");
    check(args[i + 1] && !args[i + 1].startsWith("--"), "Missing option value");
    result[key] = args[i + 1];
  }
  for (const key of allowed.slice(0, 4)) check(result[key], `Required --${key}`);
  check(/^(?:aro|irang)-package-qa(?:-[a-z0-9][a-z0-9_-]{0,30})?$/.test(result.project),
    "Project namespace must be aro-package-qa or a suffixed QA name");
  check(/^[1-9][0-9]{0,4}$/.test(result.port) && Number(result.port) >= 1024 &&
    Number(result.port) <= 65535, "Invalid port (1024..65535)");
  check(/^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/.test(result.image) &&
    !result.image.includes("..") && !result.image.includes("//"), "Invalid image reference");
  return result;
}

let input;
try { input = options(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(1); }

const evidence = path.resolve(input["evidence-dir"]);
const source = path.resolve(input["install-dir"] ?? path.join(import.meta.dir, ".."));
const receipts = { image: input.image, project: input.project, scenarios: [], cleanup: [], status: "FAIL" };
const secrets = new Set(["aro-package-smoke-password"]);
const leases = [];
const password = "aro-package-smoke-password";
const ai = { chat: null, chatConsent: false, jev: null, jevConsent: false };
const fixtures = [];
const runNames = new Set();
const owner = randomUUID();
let temporary;
let interrupted = false;
let child;

function safe(value) {
  let text = String(value);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[REDACTED]");
  return text.replace(/(?:aro_session|sb_session)=[^;\s"]+/g, "session=[REDACTED]")
    .replace(/\$argon2[^\s"]+/g, "[REDACTED HASH]");
}
function record(name, data) {
  receipts.scenarios.push({ name, ...JSON.parse(safe(JSON.stringify(data))) });
}
// No host credentials, DATABASE_URL, AI keys, auth homes or Compose overrides.
const environment = { PATH: process.env.PATH, HOME: temporary ?? tmpdir(), DOCKER_CONFIG: "/nonexistent-aro-qa" };
async function command(args, { stdin, expect = 0, timeout = 240000, capture = false, cleanup = false } = {}) {
  check(cleanup || !interrupted, "Interrupted");
  child = Bun.spawn(args, {
    env: environment, cwd: temporary ?? source, stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe", stderr: "pipe",
  });
  const current = child;
  const timer = setTimeout(() => current.kill("SIGKILL"), timeout);
  if (stdin !== undefined) { current.stdin.write(stdin); current.stdin.end(); }
  const [code, stdout, stderr] = await Promise.all([
    current.exited, new Response(current.stdout).text(), new Response(current.stderr).text(),
  ]).finally(() => { clearTimeout(timer); if (child === current) child = undefined; });
  record("command", { command: args, exitCode: code });
  if (capture) record(args[0], { command: args, exitCode: code, stdout, stderr });
  if (expect !== null) check(code === expect, `${args[0]} failed (exit ${code}): ${safe(stderr)}`);
  return { code, stdout, stderr };
}
function compose(fixture, args, extras = {}) {
  return command(["docker", "compose", "--project-directory", fixture.directory,
    "--env-file", fixture.env, "-p", fixture.project, "-f",
    path.join(fixture.directory, "compose.yml"), ...args], extras);
}
async function collisions(project) {
  for (const [kind, args] of [
    ["container", ["ps", "-aq"]], ["network", ["network", "ls", "-q"]], ["volume", ["volume", "ls", "-q"]],
  ]) {
    const labeled = await command(["docker", ...args, "--filter", `label=com.docker.compose.project=${project}`]);
    check(!labeled.stdout.trim(), `Existing ${kind} project label: ${project}`);
  }
  // Labels alone miss foreign/unlabelled objects occupying deterministic names.
  for (const [kind, names] of [
    ["container", [`${project}-app-1`, `${project}-db-1`, `${project}-bootstrap`, `${project}-cli`]],
    ["network", [`${project}_default`]],
    ["volume", ["app-data", "postgres-data", "second_brain_pg18"].map(key => `${project}_${key}`)],
  ]) {
    const args = kind === "container" ? ["container", "ls", "-a", "--format", "{{.Names}}"] :
      [kind, "ls", "--format", "{{.Name}}"];
    const existing = (await command(["docker", ...args])).stdout.trim().split("\n");
    check(!names.some(name => existing.includes(name)), `Existing ${kind} namespace: ${project}`);
  }
}
async function dockerRun(project, purpose, args, extras) {
  const name = `${project}-${purpose}`;
  const existing = await command(["docker", "ps", "-aq", "--filter", `name=^/${name}$`]);
  check(!existing.stdout.trim(), `Run container already exists: ${name}`);
  runNames.add(name);
  const result = await command(["docker", "run", "--rm", "--name", name,
    "--label", `aro.smoke.owner=${owner}`, "--label", "aro.qa.owner=aro-id-release", ...args], extras);
  runNames.delete(name);
  return result;
}
async function http(fixture, name, url, status, { method = "GET", json, form, cookie, origin } = {}) {
  const headers = {};
  if (method !== "GET") headers.Origin = origin ?? fixture.base;
  if (cookie) headers.Cookie = cookie;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(fixture.base + url, {
    method, headers, body: form ?? (json === undefined ? undefined : JSON.stringify(json)),
    redirect: "manual", signal: AbortSignal.timeout(15000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const body = response.headers.get("content-type")?.includes("application/json") ?
    JSON.parse(new TextDecoder().decode(bytes)) : { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  const responseHeaders = Object.fromEntries(response.headers);
  const cookieHeader = response.headers.get("set-cookie");
  if (cookieHeader) {
    const value = cookieHeader.match(/(?:aro_session|sb_session)=([^;]+)/)?.[1];
    if (value) secrets.add(value);
  }
  record(name, { method, url, status: response.status, headers: responseHeaders, body, expectedStatus: status });
  check(response.status === status, `${name}: expected HTTP ${status}, received ${response.status}`);
  return { body, bytes, cookieHeader };
}
async function database(fixture, sql) {
  const result = await compose(fixture, ["exec", "-T", "db", "psql", "-U", "postgres", "-d", fixture.database, "-Atc", sql]);
  return result.stdout.trim();
}
async function counts(fixture, users, settings) {
  const actual = await database(fixture,
    "SELECT (SELECT count(*) FROM users)||','||(SELECT count(*) FROM installation_settings)||','||(SELECT count(*) FROM notes);");
  check(actual.startsWith(`${users},${settings},`), "Unexpected owner/settings count");
  record("database-counts", { project: fixture.project, actual });
  const active = await database(fixture,
    "SELECT (SELECT count(*) FROM installation_settings WHERE ai->'chatId' IS DISTINCT FROM 'null'::jsonb OR ai->'jevId' IS DISTINCT FROM 'null'::jsonb) + (SELECT count(*) FROM ai_connections);");
  check(active === "0", "AI connection activated");
}
async function mounts(fixture) {
  const ids = (await compose(fixture, ["ps", "-q"])).stdout.trim().split("\n").filter(Boolean);
  check(ids.length === 2, "Expected two services");
  const items = JSON.parse((await command(["docker", "inspect", ...ids])).stdout);
  return items.flatMap(item => item.Mounts.filter(mount => mount.Type === "volume").map(mount => mount.Name)).sort();
}
async function login(fixture) {
  const result = await http(fixture, "login", "/api/auth/login", 200, { method: "POST", json: { password } });
  check(result.cookieHeader?.includes("HttpOnly") && /SameSite=Lax/i.test(result.cookieHeader) &&
    !/;\s*Secure/i.test(result.cookieHeader), "Invalid loopback session cookie policy");
  const cookie = result.cookieHeader.match(/(?:aro_session|sb_session)=[^;]+/)?.[0];
  check(cookie, "Missing session cookie");
  return cookie;
}
async function persist(fixture) {
  const cookie = await login(fixture);
  const note = (await http(fixture, "create-note", "/api/notes", 201, {
    method: "POST", cookie, json: { title: "Packaging smoke", body: "Synthetic persistence fixture", tags: ["packaging-smoke"] },
  })).body.note;
  check(typeof note?.id === "string", "Missing note ID");
  const form = new FormData();
  form.set("file", new File([new Uint8Array([0, 1, 2, 3, 255])], "smoke.bin", { type: "application/octet-stream" }));
  form.set("noteId", note.id);
  const uploaded = (await http(fixture, "upload", "/api/attachments", 201, { method: "POST", cookie, form })).body;
  check(uploaded.url === `/api/attachments/${uploaded.id}`, "Invalid attachment URL");
  await http(fixture, "anonymous-download", uploaded.url, 401);
  const verify = async (session) => {
    const saved = (await http(fixture, "read-note", `/api/notes/${note.id}`, 200, { cookie: session })).body.note;
    check(saved.id === note.id && saved.body === "Synthetic persistence fixture", "Note persistence mismatch");
    const file = await http(fixture, "download", uploaded.url, 200, { cookie: session });
    check(Buffer.from(file.bytes).equals(Buffer.from([0, 1, 2, 3, 255])), "Attachment bytes changed");
  };
  await verify(cookie);
  const before = await mounts(fixture);
  // Synthetic sentinels prove auth-once homes survive; no provider login/network call.
  await compose(fixture, ["exec", "-T", "app", "sh", "-ec",
    "mkdir -p \"$CODEX_HOME\" \"$GEMINI_CLI_HOME\"; printf synthetic > \"$CODEX_HOME/qa-sentinel\"; printf synthetic > \"$GEMINI_CLI_HOME/qa-sentinel\""]);
  await compose(fixture, ["down"]);
  await compose(fixture, ["up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180"]);
  check(JSON.stringify(before) === JSON.stringify(await mounts(fixture)), "Physical volumes changed");
  await compose(fixture, ["exec", "-T", "app", "sh", "-ec",
    "test \"$(cat \"$CODEX_HOME/qa-sentinel\")\" = synthetic; test \"$(cat \"$GEMINI_CLI_HOME/qa-sentinel\")\" = synthetic"]);
  record("auth-home-volume-boundary", { project: fixture.project, pass: true, mounts: before, providerLoginTested: false });
  const fresh = await login(fixture);
  await verify(fresh);
  const setup = await http(fixture, "setup-after-recreation", "/api/setup", 409, {
    method: "POST", json: fixture.setup,
  });
  check(setup.body.error?.code === "conflict", "Setup not closed after recreation");
  const notesBefore = await database(fixture, "SELECT count(*) FROM notes;");
  const denied = await http(fixture, "cross-origin", "/api/notes", 403, {
    method: "POST", cookie: fresh, origin: "https://untrusted.example", json: { title: "Must not exist" },
  });
  check(denied.body.error?.code === "forbidden" &&
    notesBefore === await database(fixture, "SELECT count(*) FROM notes;"), "Cross-origin write changed data");
}
async function fixture(project, legacy) {
  const directory = path.join(temporary, project);
  await mkdir(directory);
  const composeDocument = Bun.YAML.parse(await readFile(path.join(source, "compose.yml"), "utf8"));
  for (const service of Object.values(composeDocument.services)) service.labels = { ...service.labels, "aro.qa.owner": "aro-id-release" };
  for (const [name, volume] of Object.entries(composeDocument.volumes)) {
    composeDocument.volumes[name] = { ...volume, labels: { ...volume?.labels, "aro.qa.owner": "aro-id-release" } };
  }
  composeDocument.networks = { default: { labels: { "aro.qa.owner": "aro-id-release" } } };
  await writeFile(path.join(directory, "compose.yml"), Bun.YAML.stringify(composeDocument));
  await cp(path.join(source, "docker/postgres/production"), path.join(directory, "docker/postgres/production"), { recursive: true });
  // The producer checkout may be private (0700/0600). Only these public SQL
  // fixture bytes must be readable by PostgreSQL's unprivileged container user.
  await chmod(path.join(directory, "docker/postgres/production"), 0o755);
  await chmod(path.join(directory, "docker/postgres/production/01-app-role.sql"), 0o644);
  const item = { project, directory, env: path.join(directory, ".env"), base: `http://127.0.0.1:${input.port}`, database: legacy ? "second_brain" : "aro", allocated: false };
  fixtures.push(item);
  const bootstrapArgs = ["--user", `${process.getuid()}:${process.getgid()}`, "-v", `${directory}:/install`,
    input.image, "bun", "--no-env-file", "/app/scripts/setup-env.mjs", "/install/.env"];
  await dockerRun(project, "bootstrap", bootstrapArgs);
  const original = await readFile(item.env, "utf8");
  const values = Object.fromEntries(original.split("\n").filter(line => line && !line.startsWith("#")).map(line => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
  for (const key of ["POSTGRES_PASSWORD", "POSTGRES_ADMIN_PASSWORD", "SETUP_TOKEN"]) {
    check(/^[a-f0-9]{64}$/.test(values[key]), "Invalid generated secret");
    secrets.add(values[key]);
  }
  check(new Set([values.POSTGRES_PASSWORD, values.POSTGRES_ADMIN_PASSWORD, values.SETUP_TOKEN]).size === 3, "Secrets not distinct");
  check(((await stat(item.env)).mode & 0o777) === 0o600, "Env must be mode 0600");
  const repeat = await dockerRun(project, "bootstrap", bootstrapArgs, { expect: 1 });
  check(original === await readFile(item.env, "utf8"), "Bootstrap overwrote env");
  record("bootstrap", { project, mode: "0600", distinct: true, noOverwrite: true, repeatExit: repeat.code });
  delete values.IRANG_IMAGE;
  values.ARO_IMAGE = input.image; values.APP_PORT = input.port; values.INSECURE_COOKIES = "1";
  values.POSTGRES_APP_DB = item.database; values.POSTGRES_APP_USER = item.database;
  let legacyHashEnv;
  if (legacy) {
    values.POSTGRES_APP_PASSWORD = "fixture-app#with@reserved:characters";
    secrets.add(values.POSTGRES_APP_PASSWORD);
    values.DATABASE_URL = `postgres://second_brain:${encodeURIComponent(values.POSTGRES_APP_PASSWORD)}@db:5432/second_brain`;
    secrets.add(values.DATABASE_URL);
    values.POSTGRES_DATA_VOLUME = "second_brain_pg18";
    delete values.POSTGRES_ADMIN_PASSWORD;
    legacyHashEnv = (await dockerRun(project, "cli", ["-i", input.image, "bun", "--no-env-file",
      "/app/scripts/hash-password.mjs", "--env"], { stdin: `${password}\n` })).stdout.trim();
    check(legacyHashEnv.startsWith("AUTH_PASSWORD_HASH="), "Missing legacy hash environment export");
    secrets.add(legacyHashEnv);
  }
  const save = async (entries) => writeFile(item.env, Object.entries(entries).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n", { mode: 0o600 });
  await save(values);
  if (legacyHashEnv) {
    await writeFile(item.env, `${await readFile(item.env, "utf8")}${legacyHashEnv}\n`, { mode: 0o600 });
  }
  const config = JSON.parse((await compose(item, ["config", "--format", "json"])).stdout);
  check(config.services.app.image === input.image && !config.services.app.build, "Requires producer image-only Compose");
  const app = config.services.app.environment;
  const db = config.services.db.environment;
  check(app.DATABASE_URL === (values.DATABASE_URL ?? `postgres://${item.database}:${values.POSTGRES_PASSWORD}@db:5432/${item.database}`), "Wrong app URL");
  check(db.POSTGRES_PASSWORD === (values.POSTGRES_ADMIN_PASSWORD ?? values.POSTGRES_PASSWORD) &&
    db.POSTGRES_APP_PASSWORD === (values.POSTGRES_APP_PASSWORD ?? values.POSTGRES_PASSWORD), "Wrong DB secrets");
  check(!Object.keys(app).some(key => key.startsWith("POSTGRES_")) &&
    !Object.values(app).includes(db.POSTGRES_PASSWORD), "DB admin secret exposed to app");
  check(app.TYPESAFE_API_KEY === "" && app.INSECURE_COOKIES === "1", "Inherited AI/cookie environment");
  if (legacy) {
    check(typeof app.AUTH_PASSWORD_HASH === "string", "Missing rendered legacy hash");
    const hash = app.AUTH_PASSWORD_HASH.replaceAll("$$", "$");
    check(await Bun.password.verify(password, hash), "Exported legacy hash did not roundtrip through Compose");
    secrets.add(hash);
    values.AUTH_PASSWORD_HASH = hash;
    record("legacy-hash-env-roundtrip", { project, pass: true });
  }
  check(config.services.app.ports.length === 1 && config.services.app.ports[0].host_ip === "127.0.0.1" &&
    String(config.services.app.ports[0].published) === input.port, "Unsafe port mapping");
  for (const [key, volume] of Object.entries(config.volumes)) {
    check(!volume.external && volume.name === `${project}_${key}`, "Unowned volume selection");
  }
  for (const network of Object.values(config.networks)) check(!network.external && network.name === `${project}_default`, "Unowned network");
  const appMounts = config.services.app.volumes;
  check(appMounts.length === 1 && appMounts[0].type === "volume" && appMounts[0].source === "app-data", "Unexpected app mount");
  check(config.services.db.volumes[0].source === (legacy ? "second_brain_pg18" : "postgres-data"), "Wrong DB volume key");
  check(config.services.db.volumes.length === 2 &&
    config.services.db.volumes[1].type === "bind" &&
    config.services.db.volumes[1].source === path.join(directory, "docker/postgres/production") &&
    config.services.db.volumes[1].read_only === true, "Unexpected DB bind mount");
  record("private-compose-boundary", { project, pass: true, legacy, volumeNames: Object.values(config.volumes).map(volume => volume.name) });
  const invalid = { ...values };
  delete invalid[legacy ? "POSTGRES_DATA_VOLUME" : "POSTGRES_ADMIN_PASSWORD"];
  await save(invalid);
  const rejected = await compose(item, ["config", "--format", "json"], { expect: null });
  check(rejected.code !== 0, "Invalid upgrade configuration accepted");
  record("invalid-config", { project, exitCode: rejected.code });
  await save(values);
  item.setup = { setupToken: values.SETUP_TOKEN, password, passwordConfirmation: password, ai };
  await collisions(project);
  item.allocated = true;
  await compose(item, ["up", "-d", "--no-build", "--wait", "--wait-timeout", "180"]);
  const health = await http(item, "health", "/api/health", 200);
  check(health.body.ok === true, "Health body not ok");
  const anonymous = await http(item, "anonymous-notes", "/api/notes", 401);
  check(anonymous.body.error?.code === "unauthorized", "Missing unauthorized code");
  if (!legacy) {
    const wrong = await http(item, "wrong-token", "/api/setup", 403, {
      method: "POST", json: { ...item.setup, setupToken: "incorrect-code-that-is-long-enough" },
    });
    check(wrong.body.error?.code === "forbidden", "Wrong-token code");
    await counts(item, 0, 0);
    const setup = await http(item, "setup", "/api/setup", 201, { method: "POST", json: item.setup });
    check(setup.body.ok === true, "Setup body not ok");
    await counts(item, 1, 1);
  }
  const closed = await http(item, "setup-closed", "/api/setup", 409, { method: "POST", json: item.setup });
  check(closed.body.error?.code === "conflict", "Setup not closed");
  await persist(item);
  if (!legacy) await counts(item, 1, 1);
  // Free the shared loopback port before the next fixture, retain owned volumes.
  await compose(item, ["down"]);
}

async function cleanup() {
  const attempt = async (resource, action) => {
    try { await action(); }
    catch (error) {
      receipts.status = "FAIL";
      receipts.cleanup.push({ resource, success: false, error: safe(error.message) });
    }
  };
  for (const name of runNames) {
    await attempt(name, async () => {
    const inspected = await command(["docker", "container", "inspect", name], { expect: null, cleanup: true });
    if (inspected.code === 0) {
      check(JSON.parse(inspected.stdout)[0].Config.Labels["aro.smoke.owner"] === owner, "Run container ownership changed");
      await command(["docker", "rm", "-f", JSON.parse(inspected.stdout)[0].Id], { cleanup: true });
      receipts.cleanup.push({ container: name, removed: true });
    } else check(inspected.stderr.includes("No such"), "Cannot inspect run container for cleanup");
    if (inspected.code !== 0) receipts.cleanup.push({ container: name, absent: true });
    });
  }
  for (const item of fixtures.filter(item => item.allocated).reverse()) {
    await attempt(item.project, async () => {
    await compose(item, ["down", "--volumes", "--remove-orphans"], { cleanup: true });
    for (const args of [["ps", "-aq"], ["network", "ls", "-q"], ["volume", "ls", "-q"]]) {
      const result = await command(["docker", ...args, "--filter", `label=com.docker.compose.project=${item.project}`], { cleanup: true });
      check(!result.stdout.trim(), "Owned Compose resource survived cleanup");
    }
    receipts.cleanup.push({ project: item.project, containersNetworksVolumesRemoved: true });
    });
  }
  if (temporary) {
    await attempt("temporary-env", async () => {
    await rm(temporary, { recursive: true, force: true });
    receipts.cleanup.push({ temporaryEnvRemoved: true });
    });
  }
  for (const lease of leases.reverse()) {
    await attempt(lease, async () => {
      await rm(lease, { recursive: true });
      receipts.cleanup.push({ projectLeaseRemoved: true });
    });
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true; child?.kill("SIGTERM");
});

try {
  await mkdir(evidence, { recursive: true });
  for (const project of [input.project, `${input.project}-legacy`]) {
    const lease = path.join(tmpdir(), `${project}.smoke-lock`);
    await mkdir(lease, { mode: 0o700 });
    leases.push(lease);
  }
  await collisions(input.project);
  await collisions(`${input.project}-legacy`);
  temporary = await mkdtemp(path.join(tmpdir(), "aro-image-smoke-"));
  environment.HOME = temporary;
  // Keep the caller's pinned CLI plugins, never its registry credentials.
  environment.DOCKER_CONFIG = path.join(temporary, "docker-config");
  await mkdir(environment.DOCKER_CONFIG, { mode: 0o700 });
  await writeFile(path.join(environment.DOCKER_CONFIG, "config.json"), JSON.stringify({
    cliPluginsExtraDirs: [path.resolve(process.env.DOCKER_CONFIG ?? path.join(homedir(), ".docker"), "cli-plugins")],
  }), { mode: 0o600 });
  const ready = await dockerRun(input.project, "cli", [input.image, "sh", "-ec",
    "id -u; bun --version; node --version; codex --version; gemini --version"]);
  const lines = ready.stdout.trim().split("\n");
  check(lines[0] === "1001" && lines[1] === "1.4.2" && /^v22\./.test(lines[2]) &&
    lines.some(line => /codex.*0\.158\.0/.test(line)) && lines.some(line => /0\.61\.0/.test(line)), "UID/CLI readiness mismatch");
  record("uid-cli", { exitCode: ready.code, stdout: ready.stdout });
  await fixture(input.project, false);
  await fixture(`${input.project}-legacy`, true);
  receipts.status = "PASS";
} catch (error) {
  receipts.error = safe(error.message);
  console.error(receipts.error);
  for (const item of fixtures.filter(item => item.allocated)) {
    try {
      await compose(item, ["logs", "--no-color", "--tail", "100", "db"], {
        expect: null, capture: true, cleanup: true,
      });
    } catch (diagnosticError) {
      record("database-diagnostic", { error: safe(diagnosticError.message) });
    }
  }
} finally {
  try { await cleanup(); }
  catch (error) { receipts.status = "FAIL"; receipts.cleanup.push({ error: safe(error.message), success: false }); }
  if (interrupted) { receipts.status = "FAIL"; receipts.error = "Interrupted"; }
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, "smoke-receipt.json"), JSON.stringify(receipts, null, 2) + "\n");
  console.log(JSON.stringify({ status: receipts.status, receipt: path.join(evidence, "smoke-receipt.json"), cleanup: receipts.cleanup }));
  process.exitCode = receipts.status === "PASS" ? 0 : 1;
}
