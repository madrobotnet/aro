import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, chmod, readFile, stat, symlink, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { options, digest, databaseDigest, save } from "./backup/common.mjs";
import { validateBackup } from "./restore-check.mjs";

const scripts = import.meta.dir;
async function command(args, env = {}) {
  const child = Bun.spawn(args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(),
    new Response(child.stderr).text()]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}
const cli = (script, args, env) => command([Bun.which("node"), join(scripts, script), ...args], env);
test("CLI rejects missing, unknown, duplicate and malformed options", async () => {
  for (const script of ["backup.mjs", "restore-check.mjs"]) {
    expect((await cli(script, ["--help"])).code).toBe(0);
    for (const args of [[], ["--bogus", "x"], ["--backup"], ["--help", "x"]])
      expect((await cli(script, args)).code).toBe(1);
  }
  assert.throws(() => options(["--x", "a", "--x", "b"], ["x"]), /Duplicate/);
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "irang-backup-test-"));
  const release = { schemaVersion: 1, version: "2.4.0", revision: "a".repeat(40), ref: "refs/tags/v2.4.0", image: "fixture:test" };
  const content = { "operator.env": "PRIVATE_FIXTURE_SECRET=never-print\n", "compose.yml": "services: {}\n",
    "release.json": JSON.stringify(release), "deployment.json": JSON.stringify({
      appImage: "sha256:" + "a".repeat(64), dbImage: "sha256:" + "b".repeat(64), postgresMajor: 18 }),
    "database.sql": "\\restrict one\nSELECT 42;\n\\unrestrict one\n", "app-data.tar.gz": "archive-fixture" };
  for (const [name, bytes] of Object.entries(content)) await writeFile(join(dir, name), bytes, { mode: 0o600 });
  const manifest = { schemaVersion: 1, kind: "irang-backup", version: release.version, revision: release.revision,
    files: {}, databaseSha256: await databaseDigest(join(dir, "database.sql")) };
  for (const name of Object.keys(content)) manifest.files[name] = await digest(join(dir, name));
  await save(join(dir, "manifest.json"), manifest);
  return { dir, manifest };
}
test("validates full artifact set, checksums, versions, permissions and symlinks before Docker", async () => {
  const { dir, manifest } = await fixture();
  try {
    await validateBackup(dir, "2.4.0");
    await assert.rejects(validateBackup(dir, "2.3.2"), /version mismatch/);
    await chmod(join(dir, "operator.env"), 0o644);
    await assert.rejects(validateBackup(dir, "2.4.0"), /private/);
    await chmod(join(dir, "operator.env"), 0o600);
    await writeFile(join(dir, "operator.env"), "corruption");
    const result = await cli("restore-check.mjs", ["--backup", dir, "--expected-version", "2.4.0"], { PATH: "/nonexistent" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Checksum mismatch");
    expect(result.stderr).not.toContain("PRIVATE_FIXTURE_SECRET");
    await assert.rejects(validateBackup(dir, "2.4.0"), /Checksum mismatch/);
    delete manifest.files["operator.env"];
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(validateBackup(dir, "2.4.0"), /artifact set/);
    await rm(join(dir, "database.sql"));
    await symlink("/etc/passwd", join(dir, "database.sql"));
    manifest.files["operator.env"] = { bytes: 10, sha256: "0".repeat(64) };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(validateBackup(dir, "2.4.0"), /non-symlink/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("streaming database hash excludes random restrict tokens, not row contents", async () => {
  const { dir } = await fixture();
  try {
    const first = await databaseDigest(join(dir, "database.sql"));
    await writeFile(join(dir, "other.sql"), "\\restrict two\nSELECT 42;\n\\unrestrict two\n");
    expect(await databaseDigest(join(dir, "other.sql"))).toBe(first);
    await writeFile(join(dir, "other.sql"), "\\restrict two\nSELECT 43;\n\\unrestrict two\n");
    expect(await databaseDigest(join(dir, "other.sql"))).not.toBe(first);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("foreign projects, foreign volumes and bind mounts fail before downtime", async () => {
  for (const failure of ["project", "volume", "bind"]) {
    const dir = await mkdtemp(join(tmpdir(), "irang-backup-target-"));
    try {
      const install = join(dir, "install"), bin = join(dir, "bin"), log = join(dir, "calls");
      await mkdir(install); await mkdir(bin);
      await writeFile(join(install, ".env"), "PRIVATE_FIXTURE_SECRET=never-print\n");
      await writeFile(join(install, "compose.yml"), "fixture");
      await writeFile(join(install, "release.json"), JSON.stringify({ schemaVersion: 1,
        version: "2.4.0", revision: "a".repeat(40), ref: "refs/tags/v2.4.0", image: "fixture:test" }));
      await writeFile(join(bin, "docker"), `#!${Bun.which("node")}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const labels = service => ({ "com.docker.compose.project": ${JSON.stringify(failure === "project" ? "foreign" : "fixture")},
  "com.docker.compose.service": service });
let out;
if (args[0] === "compose" && args.includes("config")) out = { services: { app: { image: "fixture:test" }, db: {} } };
else if (args[0] === "compose" && args.includes("ps")) out = (args.at(-1) === "app" ? "a" : "b").repeat(64);
else if (args[0] === "inspect") out = ["app", "db"].map((service, i) => ({
  Id: (i ? "b" : "a").repeat(64), Image: "sha256:" + "c".repeat(64),
  Config: { Labels: labels(service) }, State: { Running: true },
  Mounts: [{ Type: ${JSON.stringify(failure === "bind" ? "bind" : "volume")},
    Name: "fixture_" + service, Destination: i ? "/var/lib/postgresql" : "/app/.data" }]
}));
else if (args[0] === "exec") out = "pg_dump (PostgreSQL) 18.3";
else if (args[0] === "volume") out = [{ Labels: { "com.docker.compose.project": "foreign" } }];
else process.exit(9);
console.log(typeof out === "string" ? out : JSON.stringify(out));
`, { mode: 0o700 });
      const result = await cli("backup.mjs", ["--install-dir", install, "--project", "fixture",
        "--output", join(dir, "out")], { PATH: bin });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/project\/service mismatch|not owned|stock named/);
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
      expect(calls.some(args => ["stop", "start", "run", "rm"].includes(args[0]))).toBe(false);
      await assert.rejects(stat(join(dir, "out")), { code: "ENOENT" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test.skipIf(process.env.IRANG_BACKUP_CONTAINER_QA !== "1")("real disposable DB/files roundtrip, prior state and failed dump recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "irang-backup-surface-"));
  const project = `irang-backup-qa-${randomUUID()}`;
  const image = `${project}:fixture`, compose = join(dir, "install"), output = join(dir, "backup");
  const docker = async args => {
    const result = await command(["docker", ...args]);
    assert.equal(result.code, 0, `Docker ${args[0]} failed: ${result.stderr}`);
    return result.stdout;
  };
  const dc = args => docker(["compose", "-p", project, "-f", join(compose, "compose.yml"), ...args]);
  let imageBuilt = false;
  try {
    await mkdir(compose);
    // Copy tools into scratch so the fixture app does not inherit PostgreSQL's
    // implicit anonymous data VOLUME. Its only mount must match the stock app.
    await writeFile(join(compose, "Dockerfile"), 'FROM pgvector/pgvector:0.8.6-pg18 AS tools\nFROM scratch\nCOPY --from=tools / /\nLABEL org.opencontainers.image.version="2.4.0" org.opencontainers.image.revision="' + "a".repeat(40) + '"\n');
    await docker(["build", "--pull=false", "-t", image, compose]); imageBuilt = true;
    await writeFile(join(compose, ".env"), "FIXTURE_SECRET=synthetic-private\n", { mode: 0o600 });
    await writeFile(join(compose, "release.json"), JSON.stringify({ schemaVersion: 1, version: "2.4.0",
      revision: "a".repeat(40), ref: "refs/tags/v2.4.0", image }));
    await writeFile(join(compose, "compose.yml"), JSON.stringify({
      services: {
        app: { image, entrypoint: ["sleep", "infinity"], volumes: ["app-data:/app/.data"] },
        db: { image: "pgvector/pgvector:0.8.6-pg18", environment: {
          POSTGRES_HOST_AUTH_METHOD: "trust", POSTGRES_DB: "second_brain" },
          volumes: ["postgres-data:/var/lib/postgresql"],
          healthcheck: { test: ["CMD-SHELL", 'pg_isready -U postgres -d second_brain && { read comm < /proc/1/comm; test "$$comm" = postgres; }'],
            interval: "1s", timeout: "2s", retries: 60 } },
      }, volumes: { "app-data": {}, "postgres-data": {} },
    }));
    await dc(["up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120"]);
    await dc(["exec", "-T", "db", "psql", "-U", "postgres", "-d", "second_brain", "-v", "ON_ERROR_STOP=1", "-c",
      "CREATE ROLE second_brain LOGIN; CREATE EXTENSION vector; CREATE TABLE notes(id int, body text, trashed boolean); ALTER TABLE notes OWNER TO second_brain; INSERT INTO notes VALUES (1,'persisted fixture',false),(2,'trash fixture',true); CREATE TABLE sessions(token text); INSERT INTO sessions VALUES ('synthetic-private-session');"]);
    await dc(["exec", "-T", "app", "sh", "-ec",
      "mkdir -p /app/.data/attachments /app/.data/auth/codex; printf 'binary-fixture\\000\\377' > /app/.data/attachments/file.bin; printf 'synthetic-auth-only' > /app/.data/auth/codex/auth.json; chown -R 1001:1001 /app/.data; chmod 600 /app/.data/auth/codex/auth.json"]);
    const args = ["--install-dir", compose, "--project", project, "--output", output];
    const backup = await cli("backup.mjs", args);
    assert.equal(backup.code, 0, backup.stderr);
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    for (const name of Object.keys((await validateBackup(output, "2.4.0")).manifest.files))
      expect((await stat(join(output, name))).mode & 0o777).toBe(0o600);
    const verify = await cli("restore-check.mjs", ["--backup", output, "--expected-version", "2.4.0"]);
    assert.equal(verify.code, 0, verify.stderr);
    expect(verify.stdout).toContain("RESTORE_CHECK_OK");
    const broken = join(dir, "broken-backup");
    await cp(output, broken, { recursive: true });
    const brokenManifest = JSON.parse(await readFile(join(broken, "manifest.json")));
    await writeFile(join(broken, "database.sql"), (await readFile(join(broken, "database.sql"), "utf8")) +
      "\nSELECT * FROM intentionally_missing_fixture_table;\n");
    brokenManifest.files["database.sql"] = await digest(join(broken, "database.sql"));
    brokenManifest.databaseSha256 = await databaseDigest(join(broken, "database.sql"));
    await writeFile(join(broken, "manifest.json"), JSON.stringify(brokenManifest));
    const before = await docker(["volume", "ls", "-q", "--filter", "label=irang.backup.owner"]);
    const badRestore = await cli("restore-check.mjs", ["--backup", broken, "--expected-version", "2.4.0"]);
    expect(badRestore.code).toBe(1);
    expect(badRestore.stdout).not.toContain("RESTORE_CHECK_OK");
    expect(await docker(["volume", "ls", "-q", "--filter", "label=irang.backup.owner"])).toBe(before);
    expect(await docker(["ps", "-aq", "--filter", "label=irang.backup.owner"])).toBe("");
    expect((await cli("backup.mjs", args)).code).toBe(1); // No overwrite.
    const appId = await dc(["ps", "-aq", "app"]);
    expect(await docker(["inspect", "--format", "{{.State.Running}}", appId])).toBe("true");
    await dc(["stop", "app"]);
    assert.equal((await cli("backup.mjs", [...args.slice(0, -1), join(dir, "stopped-backup")])).code, 0);
    expect(await docker(["inspect", "--format", "{{.State.Running}}", appId])).toBe("false");
    await dc(["start", "app"]);
    await dc(["exec", "-T", "db", "psql", "-U", "postgres", "-d", "postgres", "-c", "DROP DATABASE second_brain"]);
    const failure = await cli("backup.mjs", [...args.slice(0, -1), join(dir, "failed-backup")]);
    expect(failure.code).toBe(1);
    expect(failure.stdout).not.toContain("BACKUP_OK");
    expect(await docker(["inspect", "--format", "{{.State.Running}}", appId])).toBe("true");
    await assert.rejects(readFile(join(dir, "failed-backup/manifest.json")), { code: "ENOENT" });
    const sandbox = verify.stdout.split(" ")[1];
    expect(await docker(["ps", "-aq", "--filter", `label=irang.backup.owner=${sandbox.replace("irang-backup-qa-", "")}`])).toBe("");
    expect(await docker(["volume", "ls", "-q", "--filter", `label=irang.backup.owner=${sandbox.replace("irang-backup-qa-", "")}`])).toBe("");
    console.log(JSON.stringify({ project, backup: backup.stdout, restore: verify.stdout,
      verified: "notes/trash/sessions/vector + binary attachment/auth UID 1001; stopped state; failed dump restart; failed SQL restore cleanup; sandbox cleanup" }));
  } finally {
    try { await dc(["down", "-v"]); }
    finally {
      if (imageBuilt) await docker(["image", "rm", image]);
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 240000);
