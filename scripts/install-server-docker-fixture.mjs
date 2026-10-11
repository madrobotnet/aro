#!/usr/bin/env bun
// Subprocess fixture: exercises argv/env, never contacts Docker or a registry.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
await appendFile(join(process.env.HOME, "docker-calls.jsonl"),
  JSON.stringify({ args, leaked: Boolean(process.env.SETUP_TOKEN || process.env.IRANG_IMAGE || process.env.COMPOSE_FILE) }) + "\n");
const mode = process.env.DOCKER_CONFIG?.split("/").at(-1);
if (mode === "old-compose" && args[0] === "compose" && args[1] === "version") {
  console.log("2.40.0");
} else if (args[0] === "compose" && args[1] === "version") {
  console.log("5.5.1");
} else if (args[0] === "context") {
  console.log(mode === "remote" ? "tcp://production.invalid:2376" : "unix:///var/run/docker.sock");
} else if (args[0] === "info") {
  console.log(`linux/${process.arch === "arm64" ? "aarch64" : "x86_64"}`);
} else if (args.includes("ls")) {
  if (mode === "occupied" && args[0] === "volume" && args.includes("label=com.docker.compose.project=fixture-server")) console.log("existing-volume");
  if (mode === "unlabelled" && args.includes("name=^fixture-server_postgres-data$")) console.log("fixture-server_postgres-data");
} else if (mode === "denied" && args[0] === "pull") {
  console.error("denied: fixture-secret-never-forward-this");
  process.exitCode = 1;
} else if (mode === "startup-failure" && args.includes("up")) {
  console.error("SETUP_TOKEN=fixture-secret-never-forward-this");
  process.exitCode = 1;
}
