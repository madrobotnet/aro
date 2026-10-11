import assert from "node:assert/strict";
import { lstat, readFile, realpath, readdir, chmod, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";

export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function updateOptions(argv, required, optional = []) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2), value = argv[i + 1];
    assert(argv[i]?.startsWith("--") && [...required, ...optional].includes(key) &&
      !Object.hasOwn(result, key) && value && !value.startsWith("--"), "Invalid update arguments");
    result[key] = value;
  }
  assert(required.every(key => result[key]), `Required: ${required.map(key => `--${key}`).join(" ")}`);
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(result.version), "Explicit stable version required");
  assert(/^[a-f0-9]{64}$/.test(result.sha256), "Explicit trusted archive SHA-256 required");
  assert(process.platform === "linux" && typeof Bun !== "undefined" &&
    Bun.semver.satisfies(Bun.version, ">=1.4.2"), "Linux and Bun >=1.4.2 required");
  return result;
}
export async function owned(path, directory, privatePath = true) {
  assert(path === resolve(path), "Canonical absolute path required");
  assert.equal(await realpath(path), path, "Symlink path refused");
  const info = await lstat(path);
  assert(info.uid === process.getuid() && (directory ? info.isDirectory() : info.isFile()) &&
    (directory || info.nlink === 1) && !(info.mode & 0o7000) &&
    (!privatePath || !(info.mode & 0o077)), "Owned regular private path required");
  return info;
}
export async function absent(path) {
  assert(path === resolve(path), "Canonical absolute output required");
  await owned(dirname(path), true);
  try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Output already exists");
}
export function separate(paths) {
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    assert(paths[i] !== paths[j] && !paths[i].startsWith(`${paths[j]}/`) &&
      !paths[j].startsWith(`${paths[i]}/`), "App, data, backup and staging paths must be separate");
  }
}
export async function artifact(input, limit) {
  await owned(input.archive, false, false);
  assert((await lstat(input.archive)).size <= limit, "Archive too large");
  const bytes = await readFile(input.archive);
  assert(bytes.length <= limit && hash(bytes) === input.sha256, "Archive SHA-256 mismatch");
  return bytes;
}
// Only seal newly reserved application artifacts, never operator input/data.
export async function seal(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name), info = await lstat(path);
    assert(!info.isSymbolicLink(), "Staged link refused");
    if (info.isDirectory()) await seal(path);
    else await chmod(path, 0o400);
  }
  await chmod(directory, 0o500);
}
export async function plan(directory, value) {
  await writeFile(join(directory, "update-activation.json"), JSON.stringify({
    schemaVersion: 1, state: "verified-staged-not-started", ...value,
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
