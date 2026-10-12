import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { verifiedFiles } from "./install-server.mjs";
import { backup } from "./backup.mjs";
import { restoreCheck } from "./restore-check.mjs";
import { runner, releaseIdentity } from "./backup/common.mjs";
import { absent, artifact, owned, separate, seal, plan, hash } from "./update-common.mjs";
import { releasePrefix } from "./release-names.mjs";

export async function updateServer(input) {
  const current = input["current-directory"], target = input.directory, output = input.backup;
  const project = input.project;
  assert(input.authenticated === "yes", "Acknowledge authorized existing Docker login with --authenticated yes");
  assert(/^[a-z][a-z0-9-]{2,47}$/.test(project), "Explicit original Compose project required");
  assert(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT, "Unset Docker host/context overrides");
  separate([current, target, output]);
  await owned(current, true);
  await absent(target);
  await absent(output);
  for (const name of [".env", "compose.yml", "release.json"]) await owned(join(current, name), false, name === ".env");
  const environment = await readFile(join(current, ".env"));
  const originalCompose = await readFile(join(current, "compose.yml"));
  const previous = JSON.parse(await readFile(join(current, "release.json"), "utf8"));
  releaseIdentity(previous, previous.version);
  assert(Bun.semver.satisfies(input.version, `>${previous.version}`), "Only a newer stable target is supported; no DB downgrade");
  const bytes = await artifact(input, 64 * 1024 * 1024);
  const { files, release } = await verifiedFiles(bytes, input.version, input.sha256);
  const prefix = releasePrefix(input.version);
  assert(!files.has(`${prefix}/update-image.json`) && !files.has(`${prefix}/update-activation.json`), "Reserved update artifact name");
  const r = runner();
  const base = ["compose", "--project-name", project, "--project-directory", current];
  const old = [...base, "--env-file", join(current, ".env"), "-f", join(current, "compose.yml")];
  const next = [...base, "--env-file", join(target, ".env"), "-f", join(target, "compose.yml")];
  let stopped = false;
  try {
    assert((await r.run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])).startsWith("unix://"),
      "Local Unix Docker context required");
    const composeVersion = await r.run(["compose", "version", "--short"]);
    assert(Bun.semver.satisfies(composeVersion.replace(/^v/, ""), ">=5.1.0"), "Compose >=5.1.0 required");
    const architecture = await r.run(["info", "--format", "{{.OSType}}/{{.Architecture}}"]);
    assert((process.arch === "arm64" ? ["linux/arm64", "linux/aarch64"] : ["linux/amd64", "linux/x86_64"])
      .includes(architecture), "Local daemon must match native host");
    const original = JSON.parse(await r.run([...old, "config", "--format", "json"]));
    assert.deepEqual(Object.keys(original.services).sort(), ["app", "db"], "Only stock app/db update supported");
    assert.equal(original.services.app.image, previous.image, "Current release/image mismatch");
    const appId = await r.run([...old, "ps", "-aq", "app"]);
    assert(/^[a-f0-9]{12,64}$/.test(appId), "Exactly one existing app required");
    const [app] = JSON.parse(await r.run(["inspect", appId]));
    assert(app.Config.Labels?.["com.docker.compose.project"] === project &&
      app.Config.Labels?.["com.docker.compose.service"] === "app" &&
      !app.State.Paused && !app.State.Restarting, "App project/state mismatch");
    const dbId = await r.run([...old, "ps", "-aq", "db"]);
    assert(/^[a-f0-9]{12,64}$/.test(dbId), "Exactly one existing DB required");
    const [db] = JSON.parse(await r.run(["inspect", dbId]));
    assert(db.Config.Labels?.["com.docker.compose.project"] === project &&
      db.Config.Labels?.["com.docker.compose.service"] === "db" && db.State.Running &&
      !db.State.Paused && !db.State.Restarting, "DB project/state mismatch");
    const database = new URL(original.services.app.environment?.DATABASE_URL ?? "");
    const appDb = decodeURIComponent(database.pathname.slice(1));
    const appUser = decodeURIComponent(database.username);
    assert(["postgres:", "postgresql:"].includes(database.protocol) &&
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(appDb) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(appUser) &&
      original.services.db.environment?.POSTGRES_DB === appDb,
    "Cannot determine existing database and role; refusing upgrade");
    const runningEnv = Object.fromEntries((app.Config.Env ?? []).map(value => {
      const index = value.indexOf("=");
      return [value.slice(0, index), value.slice(index + 1)];
    }));
    assert(runningEnv.DATABASE_URL === database.href, "Running application database differs from configuration");
    const dbEnv = Object.fromEntries((db.Config.Env ?? []).map(value => {
      const index = value.indexOf("=");
      return [value.slice(0, index), value.slice(index + 1)];
    }));
    assert(dbEnv.POSTGRES_DB === appDb, "Running database differs from configuration");
    for (const [service, container, destination] of [
      ["app", app, "/app/.data"], ["db", db, "/var/lib/postgresql"],
    ]) {
      const mounts = original.services[service].volumes?.filter(mount => mount.type === "volume");
      assert(mounts?.length === 1, "Exactly one configured named data volume required");
      const mount = mounts[0], volume = original.volumes?.[mount.source]?.name;
      assert(typeof volume === "string" && mount.target === destination &&
        container.Mounts.some(actual => actual.Type === "volume" && actual.Name === volume &&
          actual.Destination === destination), "Configured volume differs from existing data identity");
      const [actual] = JSON.parse(await r.run(["volume", "inspect", volume]));
      assert(actual.Labels?.["com.docker.compose.project"] === project, "Configured volume project mismatch");
    }
    assert.equal(db.Config.Image, original.services.db.image, "Configured DB image differs from existing DB");
    await r.run(["pull", release.image]); // Authorization failure is before downtime.
    const [image] = JSON.parse(await r.run(["image", "inspect", release.image]));
    assert(image.Config.Labels?.["org.opencontainers.image.version"] === release.version &&
      image.Config.Labels?.["org.opencontainers.image.revision"] === release.revision,
    "New image provenance mismatch");
    await mkdir(target, { mode: 0o700 });
    for (const [name, file] of files) {
      const destination = join(target, name.slice(prefix.length + 1));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, new Uint8Array(await file.arrayBuffer()), { flag: "wx", mode: 0o600 });
    }
    // Keep the previous directory untouched and change only the staged image
    // pin. Avoid an out-of-band overlay so stock backup and the next upgrade
    // resolve the same image from this directory.
    const previousEnv = environment.toString("utf8");
    const stagedEnv = previousEnv.split(/\r?\n/).filter(line =>
      !/^(?:IRANG_IMAGE|ARO_IMAGE|POSTGRES_APP_DB|POSTGRES_APP_USER|COMPOSE_PROJECT_NAME)=/.test(line))
      .join("\n").replace(/\n*$/, "\n") +
      `ARO_IMAGE=${release.image}\nPOSTGRES_APP_DB=${appDb}\nPOSTGRES_APP_USER=${appUser}\nCOMPOSE_PROJECT_NAME=${project}\n`;
    await writeFile(join(target, ".env"), stagedEnv, { flag: "wx", mode: 0o600 });
    const resolved = JSON.parse(await r.run([...next, "config", "--format", "json"]));
    const expected = structuredClone(original);
    expected.services.app.image = release.image;
    if (resolved.services.db.environment?.POSTGRES_APP_USER === appUser) {
      expected.services.db.environment ??= {};
      expected.services.db.environment.POSTGRES_APP_USER = appUser;
    }
    // Both healthchecks target the same recorded database; only their spelling changed.
    const healthcheck = resolved.services.db.healthcheck?.test;
    if (JSON.stringify(healthcheck) === JSON.stringify(["CMD-SHELL", 'pg_isready -U postgres -d "$${POSTGRES_DB}"'])) {
      expected.services.db.healthcheck.test = healthcheck;
    }
    if (resolved["x-upgrade-checks"]?.["app-db"] === appDb &&
        resolved["x-upgrade-checks"]?.["app-user"] === appUser) {
      expected["x-upgrade-checks"] ??= {};
      expected["x-upgrade-checks"]["app-db"] = appDb;
      expected["x-upgrade-checks"]["app-user"] = appUser;
    }
    // An empty allowlist preserves the old closed-by-default public MCP
    // boundary when upgrading from a release without this optional setting.
    if (!Object.hasOwn(expected.services.app.environment ?? {}, "ARO_MCP_ALLOWED_HOSTS") &&
        resolved.services.app.environment?.ARO_MCP_ALLOWED_HOSTS === "") {
      expected.services.app.environment ??= {};
      expected.services.app.environment.ARO_MCP_ALLOWED_HOSTS = "";
    }
    assert.deepEqual(resolved, expected, "Only an app-image change is supported; project, volumes, DB and config must remain identical");
    await r.run(["stop", appId]);
    stopped = true;
    const assertStopped = async () => {
      const [item] = JSON.parse(await r.run(["inspect", appId]));
      assert(!item.State.Running && !item.State.Paused && !item.State.Restarting, "App must remain stopped");
    };
    await assertStopped();
    // Backup sees an already-stopped app, so its normal restart behavior cannot
    // admit post-snapshot writes while the operator prepares activation.
    await backup({ "install-dir": current, project, output });
    await restoreCheck({ backup: output, "expected-version": previous.version });
    await assertStopped();
    assert.equal(hash(await readFile(join(current, ".env"))), hash(environment), "Operator environment changed");
    assert.equal(hash(await readFile(join(current, "compose.yml"))), hash(originalCompose), "Operator Compose changed");
    await plan(target, {
      mode: "server", version: input.version, archiveSha256: input.sha256,
      previousDirectory: current, project, backup: output,
      activation: ["docker", ...next, "up", "-d", "--no-deps", "--pull", "never",
        "--wait", "--wait-timeout", "180", "app"],
      managementPrefix: ["docker", ...next],
      recovery: "Do not start the previous image over a migrated DB. Restore the verified backup into a NEW isolated environment.",
    });
    await seal(target);
    return { state: "verified-staged-not-started", mode: "server", directory: target, backup: output,
      project, appStopped: true };
  } catch {
    throw new Error(stopped ? "Update incomplete; app was stopped, current startup state unconfirmed. Preserve backup/staging; no rollback performed." :
      "Update preparation failed; no activation attempted. Preserve staging if present.");
  } finally { r.dispose(); }
}
