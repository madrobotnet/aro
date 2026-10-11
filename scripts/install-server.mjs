#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const help = `Fresh server installation only (Bun >=1.4.2, Linux amd64/arm64).
bun --no-env-file scripts/install-server.mjs --version VERSION --sha256 ARCHIVE_SHA256
  --directory NEW_DIRECTORY --project NEW_COMPOSE_PROJECT [--port 3000]
  [--authenticated] [--dry-run] [--archive LOCAL_RELEASE_ARCHIVE] [--password-stdin]
--authenticated acknowledges an existing authorized docker login to ghcr.io.
--dry-run validates the archive and plan without Docker, file writes, or startup.
--archive avoids downloading; otherwise use the public GitHub release asset.
--password-stdin creates the owner through the protected local setup API without copying a token.
Retrieve a code locally: bun --no-env-file scripts/install-server.mjs --token --directory DIRECTORY
Token output requires an interactive terminal; never redirect or record it.
No upgrades, Docker installation, sudo, login, or deletion are performed.`;

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    assert(["--version", "--sha256", "--directory", "--project", "--port", "--archive",
      "--authenticated", "--dry-run", "--token", "--help", "--password-stdin"].includes(key), "Unknown option");
    assert(!Object.hasOwn(result, key), "Duplicate option");
    result[key] = ["--authenticated", "--dry-run", "--token", "--help", "--password-stdin"].includes(key) ? true : args[++i];
    assert(result[key] !== undefined && !String(result[key]).startsWith("--"), "Missing option value");
  }
  return result;
}

async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Installation directory already exists; no install, environment, or data was changed. Use the documented backup/upgrade procedure.");
}

export async function releaseBytes(version, fetchRelease = fetch) {
  const url = `https://github.com/madrobotnet/aro/releases/download/v${version}/irang-${version}-install.tar.gz`;
  const response = await fetchRelease(url, { signal: AbortSignal.timeout(60000) });
  assert(response.ok, `Public release archive unavailable (HTTP ${response.status}); verify publication and version.`);
  assert(Number(response.headers.get("content-length") || 0) <= 64 * 1024 * 1024, "Archive too large");
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 64 * 1024 * 1024) { await reader.cancel(); throw new Error("Archive too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function verifiedFiles(bytes, version, expected) {
  assert(bytes.length <= 64 * 1024 * 1024, "Archive too large");
  assert.equal(hash(bytes), expected, "Archive SHA-256 mismatch; nothing installed");
  // Never extract an archive onto disk. Only validated file bytes are created
  // exclusively inside our newly reserved directory; archive modes/links ignored.
  const files = await new Bun.Archive(bytes).files();
  assert(files.size > 0 && files.size < 200, "Invalid archive file count");
  let size = 0;
  for (const [name, file] of files) {
    assert(/^irang\/[a-zA-Z0-9_./-]+$/.test(name) &&
      name.split("/").every(part => part && part !== "." && part !== "..") &&
      !/(^|\/)(\.env[^/]*|\.git|\.data|auth|credentials)(\/|$)/.test(name), "Unsafe archive member");
    size += file.size;
    assert(size <= 64 * 1024 * 1024, "Expanded archive too large");
  }
  const release = JSON.parse(await files.get("irang/release.json")?.text());
  assert.equal(release.schemaVersion, 1, "Unsupported release schema");
  assert.equal(release.version, version, "Release version mismatch");
  assert.equal(release.ref, `refs/tags/v${version}`, "Release ref mismatch");
  assert.match(release.revision, /^[a-f0-9]{40}$/, "Invalid release revision");
  assert.match(release.indexDigest, /^sha256:[a-f0-9]{64}$/, "Missing immutable digest");
  assert.equal(release.image, `ghcr.io/madrobotnet/irang:${version}@${release.indexDigest}`, "Release image mismatch");
  assert(["linux/amd64", "linux/arm64"].every(p => /^sha256:[a-f0-9]{64}$/.test(release.platforms?.[p])), "Missing native platforms");
  const compose = await files.get("irang/compose.yml")?.text();
  assert.equal(hash(compose), release.compose?.archiveSha256, "Compose checksum mismatch");
  const config = Bun.YAML.parse(compose);
  assert.equal(config.services?.app?.image, `\${IRANG_IMAGE:-${release.image}}`, "Compose image is not release-pinned");
  assert.deepEqual(config.services.app.ports, ['127.0.0.1:${APP_PORT:-3000}:3000'], "Compose must bind loopback only");
  assert(!config.services.app.build, "Compose must not build an image");
  assert(files.has("irang/docker/postgres/production/01-app-role.sql"), "Missing database initialization asset");
  return { files, release };
}

// Do not inherit IRANG_IMAGE, Compose overrides, SETUP_TOKEN, or shell secrets.
function dockerEnv() {
  return Object.fromEntries(["PATH", "HOME", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}
async function docker(args, message) {
  let child;
  try { child = Bun.spawn(["docker", ...args], { env: dockerEnv(), stdout: "pipe", stderr: "pipe" }); }
  catch { throw new Error("Docker is required; install Docker and Compose yourself. No system changes were made."); }
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Docker/Compose diagnostics can contain resolved secrets. Never forward them.
  assert.equal(code, 0, message);
  return output.trim();
}

async function freePort(port) {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
}

export async function completeLocalSetup(port, setupToken, password, send = fetch) {
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535, "Invalid setup port");
  assert(/^[a-f0-9]{64}$/.test(setupToken), "Invalid setup authorization");
  assert(typeof password === "string" && password.length >= 12 && password.length <= 512, "Password must contain 12–512 characters");
  const origin = `http://127.0.0.1:${port}`;
  const response = await send(`${origin}/api/setup`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ setupToken, password, passwordConfirmation: password,
      ai: { chat: null, chatConsent: false, jev: null, jevConsent: false } }),
  });
  if (!response.ok) throw new Error("Local owner setup was not confirmed; inspect setup or try your chosen login password. Do not rerun installation.");
}

export async function serverInstallCommand(argv) {
  const args = options(argv);
  if (args["--help"]) { console.log(help); return; }
  assert(typeof Bun !== "undefined" && Bun.semver.satisfies(Bun.version, ">=1.4.2"), "Bun >=1.4.2 is required");
  assert(process.platform === "linux" && ["x64", "arm64"].includes(process.arch), "Only native Linux amd64/arm64 supported");
  assert(args["--directory"], "Specify --directory explicitly");
  const directory = resolve(args["--directory"]);
  assert.equal(await realpath(dirname(directory)), dirname(directory), "Directory parent must exist and contain no symlinks");
  if (args["--token"]) {
    assert(Object.keys(args).every(k => ["--token", "--directory"].includes(k)), "Token retrieval cannot install");
    assert(process.stdout.isTTY, "Installation code requires a private interactive terminal; refusing captured output");
    assert.equal(await realpath(directory), directory, "Symlink installation directory");
    const file = join(directory, ".env"), stat = await lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid(), "Environment must be a private file owned by this operator");
    const token = /^SETUP_TOKEN=([a-f0-9]{64})$/m.exec(await readFile(file, "utf8"))?.[1];
    assert(token, "No valid installation code in environment");
    process.stdout.write(`${token}\n`);
    return;
  }
  const version = args["--version"], expected = args["--sha256"];
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), "Specify a stable --version");
  assert(/^[a-f0-9]{64}$/.test(expected), "Specify trusted --sha256 from the release checksum list");
  assert(/^[a-z][a-z0-9-]{2,47}$/.test(args["--project"]), "Specify a new lowercase --project (3-48 characters)");
  const port = Number(args["--port"] || 3000);
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535, "Port must be 1024-65535");
  await absent(directory);
  let ownerPassword;
  if (args["--password-stdin"]) {
    assert(!args["--dry-run"], "--password-stdin cannot be combined with --dry-run");
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        assert(text.length <= 1024, "Password input too large");
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    ownerPassword = text.replace(/\r?\n$/, "");
    assert(ownerPassword.length >= 12 && ownerPassword.length <= 512, "Password must contain 12–512 characters");
  }
  assert(args["--dry-run"] || args["--authenticated"], "Private GHCR requires authorized docker login ghcr.io, then --authenticated. Public release assets do not grant package access.");
  const bytes = args["--archive"] ? await readFile(resolve(args["--archive"])) : await releaseBytes(version);
  const { files, release } = await verifiedFiles(bytes, version, expected);
  if (args["--dry-run"]) {
    console.log(JSON.stringify({ dryRun: true, version, image: release.image, directory, project: args["--project"], port,
      writes: false, docker: false, setupUrl: `http://127.0.0.1:${port}/setup` }));
    return;
  }
  const composeVersion = await docker(["compose", "version", "--short"], "Docker Compose is required");
  assert(Bun.semver.satisfies(composeVersion.replace(/^v/, ""), ">=5.1.0"), "Docker Compose >=5.1.0 required");
  const endpoint = await docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], "Could not inspect Docker context");
  assert(endpoint.startsWith("unix://"), "Only a local Unix-socket Docker context is supported; refusing a remote daemon");
  const architecture = await docker(["info", "--format", "{{.OSType}}/{{.Architecture}}"], "Docker daemon unavailable; check permissions without arbitrary sudo");
  assert(["linux/x86_64", "linux/amd64", "linux/aarch64", "linux/arm64"].includes(architecture), "Docker daemon must run Linux amd64/arm64");
  assert(architecture.endsWith(process.arch === "x64" ? "amd64" : "arm64") ||
    architecture.endsWith(process.arch === "x64" ? "x86_64" : "aarch64"), "Docker daemon must match native host architecture");
  const project = args["--project"];
  for (const type of ["container", "volume", "network"]) {
    assert.equal(await docker([type, "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"],
      "Could not inspect existing Docker resources"), "", "Compose project already has resources; choose a fresh project, not existing data");
  }
  for (const name of ["app-data", "postgres-data", "second_brain_pg18"]) {
    assert.equal(await docker(["volume", "ls", "--filter", `name=^${project}_${name}$`, "--format", "{{.Name}}"],
      "Could not inspect existing volumes"), "", "Compose volume already exists; refusing data reuse");
  }
  await freePort(port);
  await docker(["pull", release.image], "Private GHCR pull failed. Authenticate with an account authorized for this package and retry; nothing installed.");
  await mkdir(directory, { mode: 0o700 }); // Atomic reservation, never merges.
  console.log(`Reserved ${directory}. On failure, preserve it and its volumes; see docs/INSTALL-SERVER.md.`);
  for (const [name, file] of files) {
    const output = join(directory, name.slice("irang/".length));
    // Public release files must be readable by the container's PostgreSQL UID
    // through its init-script bind mount. Only secrets need mode 0600.
    await mkdir(dirname(output), { recursive: true, mode: 0o755 });
    await writeFile(output, new Uint8Array(await file.arrayBuffer()), { flag: "wx", mode: 0o644 });
    await chmod(output, 0o644);
    for (let parent = dirname(output); parent !== directory; parent = dirname(parent)) await chmod(parent, 0o755);
  }
  const setupToken = randomBytes(32).toString("hex");
  await writeFile(join(directory, ".env"), [
    "# Private installation secrets. Loopback HTTP only; use secure cookies for a TLS proxy.",
    `POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}`,
    `POSTGRES_ADMIN_PASSWORD=${randomBytes(32).toString("hex")}`,
    `SETUP_TOKEN=${setupToken}`,
    `IRANG_IMAGE=${release.image}`, `COMPOSE_PROJECT_NAME=${project}`,
    `APP_PORT=${port}`, "INSECURE_COOKIES=1", "TRUSTED_PROXY_HOPS=0", "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  const compose = ["compose", "--project-name", project, "--project-directory", directory,
    "--env-file", join(directory, ".env"), "-f", join(directory, "compose.yml")];
  await docker([...compose, "config", "--quiet"], "Compose validation failed; installation files retained for recovery");
  await docker([...compose, "pull"], "Compose image pull failed; files retained. Check registry access and retry manually.");
  await docker([...compose, "up", "-d", "--wait", "--wait-timeout", "180"], "Startup failed; preserve files and volumes. Inspect locally and follow recovery instructions.");
  if (ownerPassword !== undefined) {
    try { await completeLocalSetup(port, setupToken, ownerPassword); }
    catch { throw new Error("Owner setup outcome is unconfirmed. Installation was retained; try your chosen login password before any manual recovery."); }
    console.log(`Owner created with AI disabled: http://127.0.0.1:${port}/login`);
    return;
  }
  console.log(`Started loopback server: http://127.0.0.1:${port}/setup`);
  console.log("Retrieve the installation code with --token --directory in a private terminal. No code was written to logs.");
}

if (import.meta.main || typeof Bun === "undefined") try { await serverInstallCommand(process.argv.slice(2)); } catch (error) {
  // Assertion values, subprocess diagnostics and fetch errors may contain secrets.
  console.error(error instanceof assert.AssertionError ? error.message.split("\n")[0] :
    error.code ? `Installer stopped (${error.code}); existing files/data were not overwritten.` :
    error.message === "fetch failed" ? "Release download failed; check network and publication." : error.message);
  process.exitCode = 1;
}
