import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

export const check = (value, message) => { if (!value) throw new Error(message); };
export const json = async file => {
  const text = await readFile(file, "utf8");
  try { return JSON.parse(text); } catch { throw new Error("Invalid JSON metadata (contents withheld)"); }
};
export const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
export const semver = value => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
export const imageId = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
export function options(args, required, optional = []) {
  const out = {};
  if (args.length === 1 && args[0] === "--help") return null;
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    check(args[i]?.startsWith("--") && [...required, ...optional].includes(key), `Unknown option: ${args[i]}`);
    check(!Object.hasOwn(out, key), `Duplicate --${key}`);
    check(args[i + 1] && !args[i + 1].startsWith("--"), `Missing value for --${key}`);
    out[key] = args[i + 1];
  }
  for (const key of required) check(out[key], `Required --${key}`);
  return out;
}
export async function privateFile(file) {
  const s = await lstat(file);
  check(s.isFile() && !s.isSymbolicLink(), "Expected regular non-symlink artifact");
  check((s.mode & 0o077) === 0, "Backup artifacts must be private (0600)");
  return s;
}
export async function digest(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest("hex") };
}
// PostgreSQL 18 randomizes restrict tokens; exclude only those control lines.
export async function databaseDigest(file) {
  const hash = createHash("sha256");
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!/^\\(?:un)?restrict /.test(line)) hash.update(line + "\n");
  }
  return hash.digest("hex");
}
export function runner() {
  let active;
  let interrupted = false;
  const signal = () => { interrupted = true; active?.kill("SIGTERM"); };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  async function run(args, { input, output, cleanup = false, event = false } = {}) {
    check(cleanup || !interrupted, "Interrupted");
    // Do not inherit Compose variables, provider credentials or automatic .env.
    const env = Object.fromEntries(["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG",
      "XDG_RUNTIME_DIR"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const child = spawn("docker", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    active = child;
    const timer = setTimeout(() => child.kill("SIGKILL"), 240000);
    let text = "";
    let observed = false;
    child.stderr.resume(); // Docker/SQL errors may contain secrets. Never print them.
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code));
    });
    try {
      const sink = output ? pipeline(child.stdout, createWriteStream(output, { flags: "wx", mode: 0o600 })) :
        (async () => { for await (const chunk of child.stdout) {
          text += chunk.toString();
          check(text.length <= 16 * 1024 * 1024, "Docker response exceeds limit");
          if (event && text.includes("\n")) { observed = true; child.kill("SIGTERM"); }
        } })();
      const source = input ? pipeline(createReadStream(input), child.stdin) : Promise.resolve(child.stdin.end());
      const [code] = await Promise.all([exited, sink, source]);
      const operation = args[0] === "run" ? `run ${args[args.indexOf("--entrypoint") + 1]}` :
        args[0] === "exec" ? `exec ${args.find(a => ["pg_dump", "psql"].includes(a)) ?? "command"}` : args[0];
      check(event ? observed : code === 0, `Docker ${operation} failed (exit ${code}); diagnostic output withheld`);
      check(cleanup || !interrupted, "Interrupted");
      return text.trim();
    } catch (error) { child.kill("SIGKILL"); await exited.catch(() => {}); throw error; }
    finally { clearTimeout(timer); active = undefined; }
  }
  return { run, dispose() { process.off("SIGINT", signal); process.off("SIGTERM", signal); } };
}
export const dumpArgs = database => ["pg_dump", "--clean", "--if-exists", "-U", "postgres", database];
export function databaseNames(database, user) {
  check(typeof database === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database) &&
    typeof user === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(user), "Cannot determine database/role names");
  return { database, user };
}
export const archiveArgs = ["tar", "--sort=name", "--format=gnu", "-czf", "-", "-C", "/data", "."];
export function releaseIdentity(release, version) {
  check(release.schemaVersion === 1 && semver(release.version) && release.version === version &&
    /^[a-f0-9]{40}$/.test(release.revision) && release.ref === `refs/tags/v${version}` &&
    typeof release.image === "string" && release.image.length > 0, "Release identity/version mismatch");
}
