#!/usr/bin/env node
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { check, json, options, privateFile, digest, databaseDigest, runner, releaseIdentity, imageId, dumpArgs, archiveArgs, databaseNames } from "./backup/common.mjs";

export const usage = "node scripts/restore-check.mjs --backup DIR --expected-version VERSION";
const artifacts = ["app-data.tar.gz", "compose.yml", "database.sql", "deployment.json", "operator.env", "release.json"];
export async function validateBackup(directory, version) {
  const dir = resolve(directory);
  const s = await lstat(dir);
  check(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0, "Backup directory must be private (0700), not a symlink");
  await privateFile(join(dir, "manifest.json"));
  const manifest = await json(join(dir, "manifest.json"));
  check(manifest.schemaVersion === 1 && ["aro-backup", "irang-backup"].includes(manifest.kind) && manifest.version === version,
    "Manifest format/expected version mismatch");
  check(Object.keys(manifest.files ?? {}).sort().join(",") === artifacts.join(","), "Manifest artifact set mismatch");
  for (const name of artifacts) {
    await privateFile(join(dir, name));
    const expected = manifest.files[name], actual = await digest(join(dir, name));
    check(Number.isSafeInteger(expected.bytes) && expected.bytes >= 0 && /^[a-f0-9]{64}$/.test(expected.sha256) &&
      expected.bytes === actual.bytes && expected.sha256 === actual.sha256, `Checksum mismatch: ${name}`);
  }
  const release = await json(join(dir, "release.json"));
  releaseIdentity(release, version);
  check(release.revision === manifest.revision, "Manifest/release revision mismatch");
  const deployment = await json(join(dir, "deployment.json"));
  check(imageId(deployment.dbImage) && imageId(deployment.appImage) && deployment.postgresMajor === 18,
    "Invalid pinned image identity/PostgreSQL major");
  check(await databaseDigest(join(dir, "database.sql")) === manifest.databaseSha256, "Database content digest mismatch");
  const names = manifest.database === undefined
    ? databaseNames("second_brain", "second_brain")
    : databaseNames(manifest.database.database, manifest.database.user);
  return { dir, manifest, deployment, names };
}
export async function restoreCheck(input) {
  // No sandbox, Docker command, or restore happens until all artifacts validate.
  const { dir, manifest, deployment, names } = await validateBackup(input.backup, input["expected-version"]);
  const r = runner(), owner = randomUUID(), prefix = `aro-backup-qa-${owner}`;
  const container = `${prefix}-db`, data = `${prefix}-data`, pg = `${prefix}-pg`;
  const resources = [];
  let temporary;
  async function owned(kind, name) {
    const [item] = JSON.parse(await r.run([kind, "inspect", name], { cleanup: true }));
    check((kind === "container" ? item.Config.Labels : item.Labels)?.["aro.backup.owner"] === owner,
      "Cleanup ownership mismatch");
  }
  const helper = async (args, extra = {}) => r.run(["run", "--rm", "--pull", "never", "--network", "none",
    ...(extra.input ? ["-i"] : []),
    "--name", `${prefix}-files`, "--label", `aro.backup.owner=${owner}`, "--mount",
    `type=volume,src=${data},dst=/data`, "--entrypoint", args[0], deployment.dbImage, ...args.slice(1)], extra);
  try {
    await r.run(["image", "inspect", deployment.dbImage]);
    temporary = await mkdtemp(join(tmpdir(), "aro-restore-check-"));
    for (const [kind, name] of [["container", container], ["container", `${prefix}-files`], ["volume", data], ["volume", pg]]) {
      const listing = await r.run(kind === "container" ? ["ps", "-a", "--format", "{{.Names}}"] :
        ["volume", "ls", "--format", "{{.Name}}"]);
      check(!listing.split("\n").includes(name), "Sandbox resource collision");
    }
    for (const name of [data, pg]) {
      await r.run(["volume", "create", "--label", `aro.backup.owner=${owner}`, name]);
      resources.push(["volume", name]);
      await owned("volume", name);
    }
    // Fresh disposable DB, random loopback port, no production credentials.
    await r.run(["create", "--pull", "never", "--publish", "127.0.0.1::5432", "--name", container,
      "--label", "aro.qa.owner=aro-id-runtime",
      "--label", `aro.backup.owner=${owner}`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
      "-e", `POSTGRES_DB=${names.database}`, "--mount", `type=volume,src=${pg},dst=/var/lib/postgresql`,
      "--health-cmd", `pg_isready -U postgres -d "${names.database}" && { read comm < /proc/1/comm; test "$comm" = postgres; }`, "--health-interval", "1s",
      "--health-timeout", "2s", "--health-retries", "60", deployment.dbImage]);
    resources.push(["container", container]);
    await owned("container", container);
    const since = String(Math.floor(Date.now() / 1000));
    await r.run(["start", container]);
    // Replay from before start closes the event subscription registration race.
    await r.run(["events", "--since", since, "--filter", `container=${container}`,
      "--filter", "event=health_status: healthy", "--format", "{{json .}}"], { event: true });
    await r.run(["exec", container, "psql", "-U", "postgres", "-d", names.database, "-v", "ON_ERROR_STOP=1",
      "-c", `CREATE ROLE "${names.user}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`]);
    await r.run(["exec", "-i", container, "psql", "-U", "postgres", "-d", names.database,
      "-v", "ON_ERROR_STOP=1", "--single-transaction"], { input: join(dir, "database.sql") });
    await r.run(["exec", container, ...dumpArgs(names.database)], { output: join(temporary, "database.sql") });
    check(await databaseDigest(join(temporary, "database.sql")) === manifest.databaseSha256,
      "Restored database schema/content differs");
    const listing = await helper(["tar", "-tzvf", "-"], { input: join(dir, "app-data.tar.gz") });
    check(listing.split("\n").every(line => /^[-d]/.test(line)), "Archive contains links/devices");
    const paths = await helper(["tar", "-tzf", "-"], { input: join(dir, "app-data.tar.gz") });
    check(paths.split("\n").every(p => p.startsWith("./") && !p.includes("\\") &&
      !p.split("/").includes("..")), "Unsafe archive path");
    await helper(["tar", "-xzf", "-", "-C", "/data"], { input: join(dir, "app-data.tar.gz") });
    await helper(archiveArgs, { output: join(temporary, "app-data.tar.gz") });
    check((await digest(join(temporary, "app-data.tar.gz"))).sha256 === manifest.files["app-data.tar.gz"].sha256,
      "Restored file bytes/modes/ownership differ");
  } catch (error) {
    throw new Error(`${error.message}; sandbox: ${prefix}`);
  } finally {
    const failures = [];
    try {
      try {
        const helperId = await r.run(["ps", "-aq", "--filter", `name=^/${prefix}-files$`], { cleanup: true });
        if (helperId) {
          await owned("container", `${prefix}-files`);
          await r.run(["rm", "-f", helperId], { cleanup: true });
        }
      } catch { failures.push(`${prefix}-files`); }
      for (const [kind, name] of resources.reverse()) {
        try {
          await owned(kind, name);
          await r.run(kind === "container" ? ["rm", "-f", name] : ["volume", "rm", name], { cleanup: true });
        } catch { failures.push(name); }
      }
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      r.dispose();
    }
    check(!failures.length, `Sandbox cleanup failed: ${failures.join(", ")}`);
  }
  return prefix;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const input = options(process.argv.slice(2), ["backup", "expected-version"]);
    console.log(input ? `RESTORE_CHECK_OK ${await restoreCheck(input)} (database/files verified; sandbox removed)` : usage);
  } catch (error) { console.error(`RESTORE_CHECK_FAILED: ${error.message}`); process.exitCode = 1; }
}
