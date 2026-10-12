#!/usr/bin/env node
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { check, json, save, options, digest, databaseDigest, runner, releaseIdentity, dumpArgs, archiveArgs, databaseNames } from "./backup/common.mjs";

export const usage = "node scripts/backup.mjs --install-dir DIR --project PROJECT --output NEW_DIR [--compose-file FILE]";
export async function backup(input) {
  const install = await realpath(resolve(input["install-dir"]));
  const output = resolve(input.output);
  const parent = await realpath(resolve(output, ".."));
  const canonical = join(parent, output.split("/").at(-1));
  check(relative(install, canonical).startsWith("../"), "Output must be outside installation");
  const project = input.project;
  check(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project), "Invalid project");
  const composeFile = await realpath(resolve(install, input["compose-file"] ?? "compose.yml"));
  const release = await json(join(install, "release.json"));
  releaseIdentity(release, release.version);
  const r = runner();
  const compose = args => r.run(["compose", "--project-directory", install, "--env-file", join(install, ".env"),
    "-p", project, "-f", composeFile, ...args]);
  let app, restart = false, helper;
  const helperOwner = randomUUID();
  try {
    const config = JSON.parse(await compose(["config", "--format", "json"]));
    check(Object.keys(config.services).sort().join(",") === "app,db", "Only stock app/db installation supported");
    check(config.services.app.image === release.image, "Compose app image disagrees with release.json");
    const ids = [];
    for (const service of ["app", "db"]) {
      const id = await compose(["ps", "-aq", service]);
      check(/^[a-f0-9]{12,64}$/.test(id), `Expected exactly one ${service} container`);
      ids.push(id);
    }
    const [a, db] = JSON.parse(await r.run(["inspect", ...ids]));
    app = a;
    for (const [item, service] of [[a, "app"], [db, "db"]]) {
      check(item.Config.Labels?.["com.docker.compose.project"] === project &&
        item.Config.Labels?.["com.docker.compose.service"] === service, "Container project/service mismatch");
      check(!item.State.Paused && !item.State.Restarting, "Paused/restarting container is unsupported");
    }
    check(db.State.Running, "Database must be running");
    check(/^pg_dump \(PostgreSQL\) 18\./.test(await r.run(["exec", db.Id, "pg_dump", "--version"])),
      "Only the stock PostgreSQL 18 installation is supported");
    check(a.Mounts.length === 1 && a.Mounts[0].Type === "volume" && a.Mounts[0].Destination === "/app/.data",
      "Only stock named /app/.data mount supported; preserve extra mounts separately");
    const mount = a.Mounts[0];
    const dbMounts = db.Mounts.filter(m => m.Type === "volume");
    check(dbMounts.length === 1 && ["/var/lib/postgresql", "/var/lib/postgresql/data"].includes(dbMounts[0].Destination),
      "Expected one PostgreSQL named data volume");
    for (const name of [mount.Name, dbMounts[0].Name]) {
      check(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name), "Invalid volume target");
      const [v] = JSON.parse(await r.run(["volume", "inspect", name]));
      check(v.Labels?.["com.docker.compose.project"] === project, "Volume not owned by selected Compose project");
    }
    const [image] = JSON.parse(await r.run(["image", "inspect", a.Image]));
    check(image.Config.Labels?.["org.opencontainers.image.version"] === release.version &&
      image.Config.Labels?.["org.opencontainers.image.revision"] === release.revision, "Running app release labels mismatch");
    const url = new URL(config.services.app.environment?.DATABASE_URL ?? "");
    const names = databaseNames(decodeURIComponent(url.pathname.slice(1)), decodeURIComponent(url.username));
    check(config.services.db.environment?.POSTGRES_DB === names.database, "Configured database mismatch");
    await mkdir(canonical, { mode: 0o700 }); // Exclusive; never touch an existing output.
    for (const [src, dest] of [[join(install, ".env"), "operator.env"], [composeFile, "compose.yml"],
      [join(install, "release.json"), "release.json"]]) {
      await writeFile(join(canonical, dest), await readFile(src), { flag: "wx", mode: 0o600 });
    }
    await save(join(canonical, "deployment.json"), { project, appImage: a.Image, dbImage: db.Image,
      appImageReference: a.Config.Image, dbImageReference: db.Config.Image,
      appVolume: mount.Name, dbVolume: dbMounts[0].Name, composeFile,
      resolvedCompose: config, postgresMajor: 18, appWasRunning: a.State.Running, database: names });
    restart = a.State.Running;
    if (restart) await r.run(["stop", a.Id]);
    await r.run(["exec", db.Id, ...dumpArgs(names.database)], { output: join(canonical, "database.sql") });
    const helperName = `aro-backup-qa-${helperOwner}`;
    check(!await r.run(["ps", "-aq", "--filter", `name=^/${helperName}$`]), "Backup helper name collision");
    helper = helperName;
    const invalid = await r.run(["run", "--rm", "--pull", "never", "--network", "none", "--name", helper,
      "--label", `aro.backup.owner=${helperOwner}`,
      "--mount", `type=volume,src=${mount.Name},dst=/data,readonly`, "--entrypoint", "find", db.Image,
      "/data", "-mindepth", "1", "!", "-type", "f", "!", "-type", "d", "-print", "-quit"]);
    check(!invalid, "App data contains unsupported symlinks/devices; backup refused");
    await r.run(["run", "--rm", "--pull", "never", "--network", "none", "--name", helper,
      "--label", `aro.backup.owner=${helperOwner}`,
      "--mount", `type=volume,src=${mount.Name},dst=/data,readonly`, "--entrypoint", "tar", db.Image,
      ...archiveArgs.slice(1)], { output: join(canonical, "app-data.tar.gz") });
    helper = undefined;
    // Restart failure prevents a completed manifest and successful exit.
    if (restart) {
      await r.run(["start", a.Id], { cleanup: true });
      check(await r.run(["inspect", "--format", "{{.State.Running}}", a.Id], { cleanup: true }) === "true",
        "App did not return to running state");
      restart = false;
    }
    const files = {};
    for (const name of ["operator.env", "compose.yml", "release.json", "deployment.json", "database.sql", "app-data.tar.gz"])
      files[name] = await digest(join(canonical, name));
    await save(join(canonical, "manifest.json"), { schemaVersion: 1, kind: "aro-backup", version: release.version,
      database: names,
      revision: release.revision, createdAt: new Date().toISOString(), files,
      databaseSha256: await databaseDigest(join(canonical, "database.sql")) });
    return canonical;
  } finally {
    try {
      if (helper) {
        const id = await r.run(["ps", "-aq", "--filter", `name=^/${helper}$`], { cleanup: true });
        if (id) {
          const [item] = JSON.parse(await r.run(["inspect", id], { cleanup: true }));
          check(item.Config.Labels?.["aro.backup.owner"] === helperOwner, "Backup helper cleanup ownership mismatch");
          await r.run(["rm", "-f", id], { cleanup: true });
        }
      }
    } finally {
      try { if (restart) await r.run(["start", app.Id], { cleanup: true }); }
      finally { r.dispose(); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const input = options(process.argv.slice(2), ["install-dir", "project", "output"], ["compose-file"]);
    console.log(input ? `BACKUP_OK ${await backup(input)}` : usage);
  } catch (error) { console.error(`BACKUP_FAILED: ${error.message}`); process.exitCode = 1; }
}
