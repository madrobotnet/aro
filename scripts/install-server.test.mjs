import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { completeLocalSetup, releaseBytes } from "./install-server.mjs";
import { releasePrefix, releaseRegistry } from "./release-names.mjs";

const directories = [];
const script = join(import.meta.dir, "install-server.mjs");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test("automatic owner setup sends authorization only to the protected loopback POST with AI off", async () => {
  const requests = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push({ method: request.method, url: request.url, origin: request.headers.get("origin"), body: await request.json() });
    return Response.json({ ok: true }, { status: 201 });
  } });
  try {
    await completeLocalSetup(server.port, "a".repeat(64), "private-setup-password");
    expect(requests).toEqual([{
      method: "POST", url: `http://127.0.0.1:${server.port}/api/setup`, origin: `http://127.0.0.1:${server.port}`,
      body: { setupToken: "a".repeat(64), password: "private-setup-password", passwordConfirmation: "private-setup-password",
        ai: { chat: null, chatConsent: false, jev: null, jevConsent: false } },
    }]);
  } finally { await server.stop(true); }
});

test("automatic owner setup rejects redirects and invalid credentials without retries", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } });
  } });
  try {
    await expect(completeLocalSetup(server.port, "a".repeat(64), "short")).rejects.toThrow();
    expect(requests).toBe(0);
    await expect(completeLocalSetup(server.port, "a".repeat(64), "private-setup-password")).rejects.toThrow();
    expect(requests).toBe(1);
  } finally { await server.stop(true); }
});

async function fixture(overrides = {}, version = "2.4.0") {
  const root = await mkdtemp(join(tmpdir(), "install-server-"));
  directories.push(root);
  // The interpreter must be executable, not dependent on the fixture's git mode.
  const wrapper = `#!${process.execPath} --no-env-file\nimport ${JSON.stringify(join(import.meta.dir, "install-server-docker-fixture.mjs"))};\n`;
  await writeFile(join(root, "docker"), wrapper, { mode: 0o700 });
  const prefix = releasePrefix(version);
  const image = `${releaseRegistry(version)}:${version}@sha256:${"a".repeat(64)}`;
  let compose = (await readFile(join(import.meta.dir, "../compose.yml"), "utf8"))
    .replace("ghcr.io/madrobotnet/aro:2.4.0}", `${image}}`);
  if (prefix === "irang") compose = compose.replace(`\${ARO_IMAGE:-\${IRANG_IMAGE:-${image}}}`, `\${IRANG_IMAGE:-${image}}`);
  const release = {
    schemaVersion: 1, version, ref: `refs/tags/v${version}`, revision: "b".repeat(40),
    image, indexDigest: `sha256:${"a".repeat(64)}`,
    platforms: { "linux/amd64": `sha256:${"c".repeat(64)}`, "linux/arm64": `sha256:${"d".repeat(64)}` },
    compose: { archiveSha256: digest(compose) },
  };
  const members = {
    [`${prefix}/compose.yml`]: compose,
    [`${prefix}/release.json`]: JSON.stringify(release),
    [`${prefix}/docker/postgres/production/01-app-role.sql`]: "-- fixture",
    ...overrides,
  };
  const bytes = await new Bun.Archive(members, { compress: "gzip" }).bytes();
  const archive = join(root, "release.tar.gz");
  await writeFile(archive, bytes);
  const directory = join(root, "new-install");
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const port = socket.address().port;
  await new Promise((accept, reject) => socket.close(error => error ? reject(error) : accept()));
  return { root, directory, image, bytes, archive, args: [
    "--version", version, "--sha256", digest(bytes), "--directory", directory,
    "--project", "fixture-server", "--port", String(port), "--archive", archive,
  ] };
}
async function run(f, extra = [], mode = "ok", args = f.args) {
  const child = Bun.spawn([process.execPath, "--no-env-file", script, ...args, ...extra], {
    env: { PATH: `${f.root}:${process.env.PATH}`, HOME: f.root, DOCKER_CONFIG: join(f.root, mode),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      SETUP_TOKEN: "ambient-secret", IRANG_IMAGE: "untrusted:latest", COMPOSE_FILE: "untrusted.yml" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
async function calls(f) {
  try { return (await readFile(join(f.root, "docker-calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

test("dry run verifies pins with no writes and no Docker calls", async () => {
  const f = await fixture(), before = (await readdir(f.root)).sort();
  const result = await run(f, ["--dry-run"]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, image: f.image, writes: false, docker: false });
  expect((await readdir(f.root)).sort()).toEqual(before);
  expect(await calls(f)).toEqual([]);
});

test("new installs default to the aro Compose project", async () => {
  const f = await fixture();
  const args = [...f.args];
  args.splice(args.indexOf("--project"), 2);
  const result = await run(f, ["--dry-run"], "ok", args);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).project).toBe("aro");
  expect(await calls(f)).toEqual([]);
});
test("requires explicit private registry authorization before any side effect", async () => {
  const f = await fixture(), result = await run(f);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Private GHCR");
  expect(await calls(f)).toEqual([]);
  expect(await readdir(f.root)).not.toContain("new-install");
});
test("rejects a bad checksum, wrong identity and unsafe archive paths before Docker", async () => {
  for (const overrides of [
    { "aro/release.json": '{"schemaVersion":1,"version":"9.0.0"}' },
    { "aro/../escape": "bad" },
    { "aro/.env": "bad" },
  ]) {
    const f = await fixture(overrides);
    expect((await run(f, ["--authenticated"])).code).toBe(1);
    expect(await calls(f)).toEqual([]);
    expect(await readdir(f.root)).not.toContain("new-install");
  }
  const f = await fixture();
  f.args[3] = "0".repeat(64);
  expect((await run(f, ["--authenticated"])).stderr).toContain("SHA-256 mismatch");
  expect(await calls(f)).toEqual([]);
});
test("refuses old Compose, remote Docker, existing resources and unauthorized pulls", async () => {
  for (const mode of ["old-compose", "remote", "occupied", "unlabelled", "denied"]) {
    const f = await fixture(), result = await run(f, ["--authenticated"], mode);
    expect(result.code, mode).toBe(1);
    expect(result.stderr).not.toContain("fixture-secret");
    expect(await readdir(f.root)).not.toContain("new-install");
    expect((await calls(f)).some(c => c.args.includes("up"))).toBe(false);
  }
});
test("installs exclusively, pins pull, suppresses secrets, and preserves failed startup", async () => {
  for (const mode of ["ok", "startup-failure"]) {
    const f = await fixture(), result = await run(f, ["--authenticated"], mode);
    expect(result.code, result.stderr).toBe(mode === "ok" ? 0 : 1);
    const content = await readFile(join(f.directory, ".env"), "utf8");
    const token = /^SETUP_TOKEN=(.+)$/m.exec(content)[1];
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(content).toContain(`ARO_IMAGE=${f.image}`);
    expect(content).not.toContain("IRANG_IMAGE=");
    expect(content).toContain("POSTGRES_APP_DB=aro\nPOSTGRES_APP_USER=aro");
    expect(content).toContain("INSECURE_COOKIES=1");
    expect(content).toContain("TRUSTED_PROXY_HOPS=0");
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.directory, ".env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.directory, "docker/postgres/production"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(f.directory, "docker/postgres/production/01-app-role.sql"))).mode & 0o777).toBe(0o644);
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stdout + result.stderr).not.toContain("fixture-secret");
    const records = await calls(f);
    expect(records.every(c => !c.leaked)).toBe(true);
    expect(records.some(c => c.args[0] === "pull" && c.args[1] === f.image)).toBe(true);
    expect(records.some(c => c.args.includes("--wait") && c.args.includes("180"))).toBe(true);
    const again = await run(f, ["--authenticated"]);
    expect(again.code).toBe(1);
    expect(await calls(f)).toEqual(records);
    expect(await readFile(join(f.directory, ".env"), "utf8")).toBe(content);
    const captured = await run(f, [], mode, ["--token", "--directory", f.directory]);
    expect(captured.code).toBe(1);
    expect(captured.stderr).toContain("refusing captured output");
    expect(captured.stdout + captured.stderr).not.toContain(token);
  }
});
test("refuses an existing install or symlink directory without changing its data", async () => {
  const f = await fixture();
  await writeFile(f.directory, "existing-install");
  expect((await run(f, ["--dry-run"])).code).toBe(1);
  expect(await readFile(f.directory, "utf8")).toBe("existing-install");
  await rm(f.directory);
  await symlink(f.root, f.directory);
  expect((await run(f, ["--dry-run"])).code).toBe(1);
  expect(await calls(f)).toEqual([]);
});
test("occupied loopback port prevents image pulls and installation writes", async () => {
  const f = await fixture(), socket = createServer();
  await new Promise((accept, reject) => {
    socket.once("error", reject);
    socket.listen(Number(f.args[9]), "127.0.0.1", accept);
  });
  try {
    expect((await run(f, ["--authenticated"])).code).toBe(1);
    expect((await calls(f)).some(c => c.args[0] === "pull")).toBe(false);
    expect(await readdir(f.root)).not.toContain("new-install");
  } finally { await new Promise(accept => socket.close(accept)); }
});
test("terminal-only code retrieval checks private ownership without Docker", async () => {
  const f = await fixture();
  expect((await run(f, ["--authenticated"])).code).toBe(0);
  const token = /^SETUP_TOKEN=(.+)$/m.exec(await readFile(join(f.directory, ".env"), "utf8"))[1];
  const before = await calls(f);
  async function terminalRead() {
    let output = "";
    const child = Bun.spawn([process.execPath, "--no-env-file", script, "--token", "--directory", f.directory], {
      env: { PATH: process.env.PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      terminal: { cols: 100, rows: 20, data(_terminal, bytes) { output += new TextDecoder().decode(bytes); } },
    });
    const code = await child.exited;
    child.terminal.close();
    return { code, output };
  }
  expect(await terminalRead()).toEqual({ code: 0, output: `${token}\r\n` });
  await chmod(join(f.directory, ".env"), 0o644);
  const rejected = await terminalRead();
  expect(rejected.code).toBe(1);
  expect(rejected.output).not.toContain(token);
  expect(await calls(f)).toEqual(before);
});
test("downloads through an HTTP seam with exact GitHub asset URL and clear unavailable error", async () => {
  const f = await fixture(), requests = [];
  let status = 200;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return new Response(status === 200 ? f.bytes : "not published", { status });
  } });
  const fetchRelease = (url, options) => {
    expect(url).toBe("https://github.com/madrobotnet/aro/releases/download/v2.3.2/irang-2.3.2-install.tar.gz");
    return fetch(`${server.url}asset`, options);
  };
  try {
    expect(digest(await releaseBytes("2.3.2", fetchRelease))).toBe(digest(f.bytes));
    status = 404;
    await expect(releaseBytes("2.3.2", fetchRelease)).rejects.toThrow("HTTP 404");
    expect(requests).toEqual(["/asset", "/asset"]);
  } finally { await server.stop(true); }
});

test("accepts immutable pre-2.4 archive and registry naming", async () => {
  const f = await fixture({}, "2.3.2");
  const result = await run(f, ["--dry-run"]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).image).toBe(f.image);
});

test("downloads new archive names from 2.4 onward", async () => {
  let requested;
  await releaseBytes("2.4.0", async url => {
    requested = url;
    return new Response("fixture");
  });
  expect(requested).toBe("https://github.com/madrobotnet/aro/releases/download/v2.4.0/aro-2.4.0-install.tar.gz");
});
test("setup-env never prints generated installation secrets", async () => {
  const f = await fixture();
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "setup-env.mjs"), join(f.root, ".env")],
    { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0);
  const content = await readFile(join(f.root, ".env"), "utf8");
  for (const secret of [...content.matchAll(/^(?:SETUP_TOKEN|POSTGRES_PASSWORD|POSTGRES_ADMIN_PASSWORD)=(.+)$/gm)]) {
    expect(stdout + stderr).not.toContain(secret[1]);
  }
});
