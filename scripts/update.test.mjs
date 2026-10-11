import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "./update-common.mjs";
import { openSQLite } from "../src/server/db/sqlite";
import { backupDesktop } from "./backup-desktop-common.ts";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const writable = async path => {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      await chmod(path, 0o700);
      for (const name of await readdir(path)) await writable(join(path, name));
    };
    await writable(root);
    await rm(root, { recursive: true, force: true });
  }
});
async function base() {
  const root = await mkdtemp(join(tmpdir(), "aro-update-"));
  roots.push(root);
  const current = join(root, "old"), directory = join(root, "new"), backup = join(root, "backup");
  await mkdir(current, { mode: 0o700 });
  return { root, current, directory, backup };
}
async function run(f, mode = "ok", args = f.args) {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "update.mjs"), ...args], {
    env: { PATH: `${f.root}:${process.env.PATH}`, HOME: f.root, DOCKER_CONFIG: join(f.root, mode),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", SETUP_TOKEN: "ambient-private",
      IRANG_IMAGE: "ambient:bad", COMPOSE_FILE: "ambient.yml" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
const common = f => ["--version", "2.4.1", "--sha256", f.sha256, "--archive", f.archive,
  "--current-directory", f.current, "--directory", f.directory, "--backup", f.backup];
async function desktop(extra = {}) {
  const f = await base(), data = join(f.root, "data"), temporary = join(f.root, "verification");
  await mkdir(data, { mode: 0o700 }); await mkdir(temporary, { mode: 0o700 });
  await mkdir(join(data, "attachments"), { mode: 0o700 });
  const id = "10000000-0000-4000-8000-000000000001";
  {
    using db = openSQLite({ filename: join(data, "aro.sqlite") });
    db.run("INSERT INTO users(password_hash) VALUES ('private-owner-hash')");
    db.run("INSERT INTO notes(id,title,body) VALUES (?,'persisted','body')", [id]);
    db.run("INSERT INTO attachments(note_id,filename,mime,size_bytes,storage_key) VALUES (?,'file','image/png',4,'file')", [id]);
  }
  await chmod(join(data, "aro.sqlite"), 0o600);
  await writeFile(join(data, "attachments/file"), Buffer.from([0, 1, 255, 2]), { mode: 0o600 });
  const manifest = { schemaVersion: 1, version: "2.4.0", platform: process.platform,
    arch: process.arch, entrypoint: "scripts/desktop.js", distDirectory: ".next", sourceHash: "a".repeat(64) };
  await writeFile(join(f.current, "desktop-release.json"), JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(join(f.current, "keep"), "old-code", { mode: 0o600 });
  const bytes = await new Bun.Archive({
    "aro/desktop-release.json": JSON.stringify({ ...manifest, version: "2.4.1" }),
    "aro/server.js": "// coherent fixture",
    "aro/scripts/desktop.js": "// fixture launcher",
    "aro/.next/BUILD_ID": "fixture-build", "aro/LICENSE": "fixture",
    "aro/THIRD_PARTY_NOTICES.md": "fixture", ...extra,
  }, { compress: "gzip" }).bytes();
  Object.assign(f, { data, temporary, archive: join(f.root, "desktop.tar.gz"), sha256: hash(bytes) });
  await writeFile(f.archive, bytes, { mode: 0o600 });
  f.args = ["desktop", ...common(f), "--data-dir", data, "--temp-parent", temporary];
  return f;
}
test("desktop stages verified activation with exact SQLite identities and previous code preserved", async () => {
  // Given
  const f = await desktop(), before = hash(await readFile(join(f.data, "aro.sqlite")));
  // When
  const result = await run(f);
  // Then
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).state).toBe("verified-staged-not-started");
  const plan = JSON.parse(await readFile(join(f.directory, "update-activation.json")));
  expect(plan.activation).toEqual([process.execPath, "--no-env-file", join(f.directory, "scripts/desktop.js"),
    "start", "--data-dir", f.data]);
  expect(plan.previousDirectory).toBe(f.current);
  using snapshot = new Database(join(f.backup, "aro.sqlite"), { readonly: true });
  expect(snapshot.query("SELECT id,title,body FROM notes").get()).toEqual({
    id: "10000000-0000-4000-8000-000000000001", title: "persisted", body: "body",
  });
  expect(snapshot.query("SELECT password_hash FROM users").get()).toEqual({ password_hash: "private-owner-hash" });
  expect(await readFile(join(f.backup, "attachments/file"))).toEqual(Buffer.from([0, 1, 255, 2]));
  expect(hash(await readFile(join(f.data, "aro.sqlite")))).toBe(before);
  expect(await readFile(join(f.current, "keep"), "utf8")).toBe("old-code");
  expect(await readdir(f.temporary)).toEqual([]);
  expect((await lstat(f.directory)).mode & 0o777).toBe(0o500);
});
test("desktop refuses held runtime lock without staging or replacing lock", async () => {
  // Given
  const f = await desktop();
  using launcher = new Database(join(f.data, "runtime.lock.sqlite"), { create: true });
  launcher.run("BEGIN IMMEDIATE");
  const inode = (await lstat(join(f.data, "runtime.lock.sqlite"))).ino;
  // When
  const result = await run(f);
  // Then
  expect(result.code).toBe(1);
  expect(await readdir(f.root)).not.toContain("new");
  expect(await readdir(f.root)).not.toContain("backup");
  expect((await lstat(join(f.data, "runtime.lock.sqlite"))).ino).toBe(inode);
  launcher.run("ROLLBACK");
});
test.each(["checksum", "version", "downgrade", "reserved", "unsafe", "symlink", "existing", "nested"])(
  "desktop rejects %s before backup or app mutation", async failure => {
    // Given
    const f = await desktop(failure === "reserved" ? { "aro/update-activation.json": "{}" } :
      failure === "unsafe" ? { "aro/../escape": "bad" } : {});
    if (failure === "checksum") f.args[4] = "0".repeat(64);
    if (failure === "version") f.args[2] = "2.4.2";
    if (failure === "downgrade") f.args[2] = "2.3.0";
    if (failure === "symlink") await symlink(f.current, f.directory);
    if (failure === "existing") await mkdir(f.directory, { mode: 0o700 });
    if (failure === "nested") f.args[f.args.indexOf("--directory") + 1] = join(f.data, "new");
    // When
    const result = await run(f);
    // Then
    expect(result.code).toBe(1);
    expect(await readdir(f.root)).not.toContain("backup");
    expect(await readFile(join(f.current, "keep"), "utf8")).toBe("old-code");
  },
);
test("desktop snapshot corruption fails restoration gate before staging", async () => {
  // Given
  const f = await desktop();
  await writeFile(join(f.data, "aro.sqlite"), "corrupt");
  // When
  const result = await run(f);
  // Then
  expect(result.code).toBe(1);
  expect(await readdir(f.root)).not.toContain("new");
});
test("snapshot operator seam holds runtime lock and retains completed backup on staging failure", async () => {
  // Given
  const f = await desktop();
  // When
  const result = backupDesktop(f.data, f.backup, async () => {
    using competing = new Database(join(f.data, "runtime.lock.sqlite"));
    competing.run("PRAGMA busy_timeout=0");
    expect(() => competing.run("BEGIN IMMEDIATE")).toThrow();
    throw new Error("owned-fixture staging failure");
  });
  // Then
  await expect(result).rejects.toThrow("owned-fixture staging failure");
  expect(await readdir(f.backup)).toContain("manifest.json");
  using released = new Database(join(f.data, "runtime.lock.sqlite"));
  released.run("PRAGMA busy_timeout=0");
  released.run("BEGIN IMMEDIATE");
  released.run("ROLLBACK");
});

async function server() {
  const f = await base();
  const image = version => `ghcr.io/madrobotnet/irang:${version}@sha256:${(version === "2.4.0" ? "a" : "b").repeat(64)}`;
  const release = version => ({ schemaVersion: 1, version, ref: `refs/tags/v${version}`,
    revision: (version === "2.4.0" ? "a" : "b").repeat(40), image: image(version),
    indexDigest: `sha256:${(version === "2.4.0" ? "a" : "b").repeat(64)}`,
    platforms: { "linux/amd64": `sha256:${"c".repeat(64)}`, "linux/arm64": `sha256:${"d".repeat(64)}` } });
  const compose = version => JSON.stringify({
    services: {
      app: { image: `\${IRANG_IMAGE:-${image(version)}}`, ports: ["127.0.0.1:${APP_PORT:-3000}:3000"],
        volumes: ["app-data:/app/.data"], environment: { DATABASE_URL: "private-fixture" } },
      db: { image: "postgres:18", volumes: ["postgres-data:/var/lib/postgresql"] },
    },
    volumes: { "app-data": {}, "postgres-data": {} },
  });
  const previous = release("2.4.0"), next = { ...release("2.4.1"), compose: { archiveSha256: hash(compose("2.4.1")) } };
  f.environment = `IRANG_IMAGE=${previous.image}\nCOMPOSE_PROJECT_NAME=fixture\nPOSTGRES_PASSWORD=synthetic-private-secret\nAPP_PORT=3123\n`;
  await writeFile(join(f.current, ".env"), f.environment, { mode: 0o600 });
  await writeFile(join(f.current, "release.json"), JSON.stringify(previous), { mode: 0o600 });
  await writeFile(join(f.current, "compose.yml"), compose("2.4.0"), { mode: 0o600 });
  const bytes = await new Bun.Archive({
    "irang/compose.yml": compose("2.4.1"), "irang/release.json": JSON.stringify(next),
    "irang/docker/postgres/production/01-app-role.sql": "-- fixture",
  }, { compress: "gzip" }).bytes();
  f.archive = join(f.root, "server.tar.gz"); f.sha256 = hash(bytes);
  await writeFile(f.archive, bytes, { mode: 0o600 });
  await writeFile(join(f.root, "docker"), `#!${process.execPath} --no-env-file\nimport ${JSON.stringify(join(import.meta.dir, "update-docker-fixture.mjs"))};\n`, { mode: 0o700 });
  await writeFile(join(f.root, "docker-state.json"), JSON.stringify({
    previous, next, running: true, resources: {}, sql: "SELECT 'persisted identity';\n", files: "binary-file-identity",
  }), { mode: 0o600 });
  f.args = ["server", ...common(f), "--project", "fixture", "--authenticated", "yes"];
  return f;
}
async function calls(f) {
  try { return (await readFile(join(f.root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

for (const [allowlist, expectedCode] of [["", 0], ["unexpected.example", 1]]) {
  test(`server update permits only a disabled newly added MCP allowlist (${expectedCode})`, async () => {
    const f = await server();
    const files = await new Bun.Archive(await readFile(f.archive)).files();
    const compose = Bun.YAML.parse(await files.get("irang/compose.yml").text());
    compose.services.app.environment.ARO_MCP_ALLOWED_HOSTS = allowlist;
    const content = JSON.stringify(compose);
    const release = JSON.parse(await files.get("irang/release.json").text());
    release.compose.archiveSha256 = hash(content);
    const members = {};
    for (const [name, file] of files) members[name] = new Uint8Array(await file.arrayBuffer());
    members["irang/compose.yml"] = content;
    members["irang/release.json"] = JSON.stringify(release);
    const bytes = await new Bun.Archive(members, { compress: "gzip" }).bytes();
    await writeFile(f.archive, bytes);
    f.args[f.args.indexOf("--sha256") + 1] = hash(bytes);
    const result = await run(f);
    expect(result.code, result.stderr).toBe(expectedCode);
  });
}
test("server stops before backup and stages only an image-pin change for repeatable updates", async () => {
  // Given
  const f = await server();
  // When
  const result = await run(f);
  // Then
  expect(result.code, result.stderr).toBe(0);
  const records = await calls(f), args = records.map(record => record.args);
  const stop = args.findIndex(a => a[0] === "stop");
  const dump = args.findIndex(a => a[0] === "exec" && a.includes("pg_dump") && !a.includes("--version"));
  expect(stop).toBeGreaterThan(-1); expect(dump).toBeGreaterThan(stop);
  expect(args.some(a => a[0] === "start" && a[1] === "a".repeat(64))).toBe(false);
  expect(args.some(a => a.includes("up"))).toBe(false);
  expect(records.every(record => !record.leaked)).toBe(true);
  expect(await readFile(join(f.current, ".env"), "utf8")).toBe(f.environment);
  const nextImage = JSON.parse(await readFile(join(f.root, "docker-state.json"))).next.image;
  expect(await readFile(join(f.directory, ".env"), "utf8")).toBe(f.environment.replace(/^IRANG_IMAGE=.*$/m, `IRANG_IMAGE=${nextImage}`));
  expect(await readdir(f.directory)).not.toContain("update-image.json");
  const plan = JSON.parse(await readFile(join(f.directory, "update-activation.json")));
  expect(plan.project).toBe("fixture");
  expect(plan.activation).toContain("--no-deps");
  expect(plan.activation).toContain(f.current);
  expect(plan.activation.at(-1)).toBe("app");
  const backup = JSON.parse(await readFile(join(f.backup, "deployment.json")));
  expect(backup).toMatchObject({ project: "fixture", appVolume: "fixture_app-data",
    dbVolume: "fixture_postgres-data", appWasRunning: false });
  const state = JSON.parse(await readFile(join(f.root, "docker-state.json")));
  expect(state.running).toBe(false);
  expect(state.resources).toEqual({});
  expect(result.stdout + result.stderr).not.toContain("synthetic-private-secret");
});
test.each(["checksum", "downgrade", "symlink", "existing", "nested", "unauthorized", "remote", "foreign", "volume", "drift", "denied", "provenance", "contract"])(
  "server refuses %s without stopping or activating", async mode => {
    // Given
    const f = await server();
    if (mode === "checksum") f.args[4] = "0".repeat(64);
    if (mode === "downgrade") f.args[2] = "2.3.0";
    if (mode === "symlink") await symlink(f.current, f.directory);
    if (mode === "existing") await mkdir(f.directory, { mode: 0o700 });
    if (mode === "nested") f.args[f.args.indexOf("--directory") + 1] = join(f.current, "new");
    if (mode === "unauthorized") f.args[f.args.indexOf("--authenticated") + 1] = "no";
    // When
    const result = await run(f, mode);
    // Then
    expect(result.code).toBe(1);
    const args = (await calls(f)).map(record => record.args);
    expect(args.some(a => a[0] === "stop" || a.includes("up"))).toBe(false);
    expect(await readdir(f.root)).not.toContain("backup");
    expect(result.stdout + result.stderr).not.toContain("synthetic-private-secret");
  },
);
test.each(["dump", "restore", "restore-mismatch", "cleanup"])(
  "server retains stopped app and refuses activation after %s failure", async mode => {
    // Given
    const f = await server();
    // When
    const result = await run(f, mode);
    // Then
    expect(result.code).toBe(1);
    const args = (await calls(f)).map(record => record.args);
    expect(args.some(a => a.includes("up"))).toBe(false);
    expect(args.some(a => a[0] === "start" && a[1] === "a".repeat(64))).toBe(false);
    expect((JSON.parse(await readFile(join(f.root, "docker-state.json")))).running).toBe(false);
    expect(await readdir(f.directory)).not.toContain("update-activation.json");
    expect(result.stdout + result.stderr).not.toContain("synthetic-private-secret");
    expect(await readFile(join(f.current, ".env"), "utf8")).toBe(f.environment);
  },
);
