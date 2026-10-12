#!/usr/bin/env bun
// Persisted deterministic Docker protocol fixture; never reaches a daemon.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const home = process.env.HOME, args = process.argv.slice(2);
const statePath = join(home, "docker-state.json");
const state = JSON.parse(await readFile(statePath, "utf8"));
const mode = process.env.DOCKER_CONFIG?.split("/").at(-1);
await appendFile(join(home, "calls.jsonl"), JSON.stringify({
  args, leaked: Boolean(process.env.ARO_IMAGE || process.env.IRANG_IMAGE || process.env.SETUP_TOKEN || process.env.COMPOSE_FILE),
}) + "\n");
const appId = "a".repeat(64), dbId = "b".repeat(64);
const dbImage = `sha256:${"d".repeat(64)}`;
const label = service => ({
  "com.docker.compose.project": mode === "foreign" ? "foreign" : "fixture",
  "com.docker.compose.service": service,
});
const production = service => ({
  Id: service === "app" ? appId : dbId, Image: service === "app" ? `sha256:${"c".repeat(64)}` : dbImage,
  Config: { Image: service === "app" ? state.previous.image : (state.dbReference ?? "postgres:18"), Labels: label(service),
    Env: service === "app" ? [mode === "missing-names" ? "DATABASE_URL=invalid" :
      `DATABASE_URL=${state.databaseUrl ?? "postgres://second_brain:fixture@db:5432/second_brain"}`] : ["POSTGRES_DB=second_brain"] },
  State: { Running: service === "app" ? state.running : true, Paused: false, Restarting: false },
  Mounts: [{ Type: "volume", Name: `fixture_${service === "app" ? "app-data" : "postgres-data"}`,
    Destination: service === "app" ? "/app/.data" : "/var/lib/postgresql" }],
});
let out = "";
const fail = () => { console.error("synthetic-private-secret"); process.exit(9); };
switch (args[0]) {
  case "context": out = mode === "remote" ? "tcp://fixture.invalid" : "unix:///fixture.sock"; break;
  case "info": out = `linux/${process.arch === "arm64" ? "aarch64" : "x86_64"}`; break;
  case "compose": {
    if (args.includes("version")) { out = "5.5.1"; break; }
    if (args.includes("config")) {
      if (mode === "real-config") {
        const docker = Bun.which("docker", { PATH: process.env.PATH.split(":").slice(1).join(":") });
        // The real CLI resolves its Compose plugin from the invoking user's Docker
        // configuration, so the fixture's fake HOME and DOCKER_CONFIG must not reach it.
        const realEnv = Object.fromEntries(Object.entries(process.env)
          .filter(([key]) => key !== "HOME" && key !== "DOCKER_CONFIG"));
        const child = Bun.spawn([docker, ...args], { env: realEnv, stdout: "pipe", stderr: "pipe" });
        const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(),
          new Response(child.stderr).text()]);
        if (code !== 0) fail();
        out = JSON.parse(stdout);
        break;
      }
      const envFile = args[args.indexOf("--env-file") + 1];
      const env = await readFile(envFile, "utf8");
      const image = /^ARO_IMAGE=(.+)$/m.exec(env)?.[1] || /^IRANG_IMAGE=(.+)$/m.exec(env)?.[1];
      const composeFiles = args.flatMap((arg, index) => arg === "-f" ? [args[index + 1]] : []);
      const config = Bun.YAML.parse(await readFile(composeFiles[0], "utf8"));
      config.services.app.image = image || config.services.app.image;
      for (const file of composeFiles.slice(1)) {
        const overlay = JSON.parse(await readFile(file, "utf8"));
        Object.assign(config.services.app, overlay.services.app);
      }
      for (const service of ["app", "db"]) {
        config.services[service].volumes = config.services[service].volumes.map(mount => {
          const [source, target] = mount.split(":");
          return { type: "volume", source, target };
        });
      }
      for (const name of Object.keys(config.volumes)) config.volumes[name].name = `fixture_${name}`;
      if (mode === "drift") config.volumes["app-data"].name = "fixture_wrong-data";
      if (mode === "contract" && config.services.app.image === state.next.image) config.services.db.image = "postgres:19";
      out = config;
    } else if (args.includes("ps")) out = args.at(-1) === "app" ? appId : dbId;
    else fail();
    break;
  }
  case "pull": if (mode === "denied") fail(); break;
  case "image":
    if (args[1] !== "inspect") fail();
    out = [{ Config: { Labels: {
      "org.opencontainers.image.version": args[2] === state.next.image ? state.next.version : state.previous.version,
      "org.opencontainers.image.revision": args[2] === state.next.image ? state.next.revision : state.previous.revision,
    } } }];
    if (mode === "provenance" && args[2] === state.next.image) out[0].Config.Labels["org.opencontainers.image.revision"] = "wrong";
    break;
  case "inspect":
    out = args.slice(1).map(id => id === appId ? production("app") : id === dbId ? production("db") :
      { Config: { Labels: state.resources[id]?.labels }, State: { Running: true } });
    break;
  case "container":
    if (args[1] !== "inspect" || !state.resources[args[2]]) fail();
    out = [{ Config: { Labels: state.resources[args[2]].labels }, State: { Running: true } }];
    break;
  case "stop": state.running = false; break;
  case "start": if (args[1] === appId) { state.running = true; fail(); } break;
  case "ps": out = args.includes("--filter") ? "" : Object.keys(state.resources).join("\n"); break;
  case "volume":
    if (args[1] === "inspect") out = [{ Labels: state.resources[args[2]]?.labels ||
      { "com.docker.compose.project": mode === "volume" ? "foreign" : "fixture" } }];
    else if (args[1] === "ls") out = Object.keys(state.resources).filter(name => state.resources[name].kind === "volume").join("\n");
    else if (args[1] === "create") {
      const [key, value] = args[args.indexOf("--label") + 1].split("=");
      state.resources[args.at(-1)] = { kind: "volume", labels: { [key]: value } };
      out = args.at(-1);
    } else if (args[1] === "rm") {
      if (mode === "cleanup") fail();
      delete state.resources[args[2]];
    } else fail();
    break;
  case "create": {
    const name = args[args.indexOf("--name") + 1];
    const labels = Object.fromEntries(args.flatMap((arg, index) =>
      arg === "--label" ? [args[index + 1].split("=")] : []));
    state.resources[name] = { kind: "container", labels };
    out = name;
    break;
  }
  case "events": out = "{}\n"; break;
  case "exec": {
    const id = args[1] === "-i" ? args[2] : args[1];
    if (args.includes("--version")) out = "pg_dump (PostgreSQL) 18.3";
    else if (args.includes("pg_dump")) {
      if (mode === "dump" && id === dbId) fail();
      if (id === dbId && state.running) fail(); // Writes must never escape final backup.
      out = id === dbId ? state.sql : state.resources[id]?.sql;
      if (mode === "restore-mismatch" && id !== dbId) out += "\nSELECT 'changed';";
    } else if (args.includes("psql")) {
      if (args.includes("-i")) {
        if (mode === "restore") fail();
        state.resources[id].sql = await Bun.stdin.text();
      }
    } else fail();
    break;
  }
  case "run": {
    const entry = args[args.indexOf("--entrypoint") + 1];
    const input = args.includes("-i") ? await Bun.stdin.text() : "";
    if (entry === "find") out = "";
    else if (entry === "tar") {
      if (args.includes("-tzvf")) out = "-rw------- 0/0 4 2026-01-01 ./attachment\n";
      else if (args.includes("-tzf")) out = "./attachment\n";
      else if (args.includes("-xzf")) {
        const mount = args[args.indexOf("--mount") + 1];
        const volume = /src=([^,]+)/.exec(mount)[1];
        state.resources[volume].files = input;
      } else {
        const mount = args[args.indexOf("--mount") + 1];
        const volume = /src=([^,]+)/.exec(mount)[1];
        out = volume === "fixture_app-data" ? state.files : state.resources[volume]?.files;
      }
    } else fail();
    break;
  }
  case "rm": delete state.resources[args.at(-1)]; break;
  default: fail();
}
await writeFile(statePath, JSON.stringify(state));
process.stdout.write(typeof out === "string" ? out : JSON.stringify(out));
