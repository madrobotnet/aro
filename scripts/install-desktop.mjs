#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function installDesktop(bytes, checksum, directory, dryRun = false) {
  if (!/^[a-f0-9]{64}$/.test(checksum) || sha256(bytes) !== checksum) throw new Error("Desktop archive checksum mismatch");
  if (bytes.length > 512 * 1024 * 1024) throw new Error("Desktop archive too large");
  const target = resolve(directory);
  if (await realpath(dirname(target)) !== dirname(target)) throw new Error("Installation parent must exist without symlinks");
  try { await lstat(target); throw new Error("Installation target already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const files = await new Bun.Archive(bytes).files();
  let expanded = 0;
  if (files.size === 0 || files.size > 50000) throw new Error("Invalid desktop archive inventory");
  for (const [name, file] of files) {
    if (!name.startsWith("aro/") || /[\\:\p{Cc}]/u.test(name) ||
        name.split("/").some(part => !part || part === "." || part === ".." || part === ".env" || part.startsWith(".env."))) {
      throw new Error("Unsafe desktop archive path");
    }
    expanded += file.size;
    if (expanded > 2 * 1024 * 1024 * 1024) throw new Error("Expanded desktop archive too large");
  }
  const manifest = JSON.parse(await files.get("aro/desktop-release.json")?.text());
  if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch ||
      manifest.entrypoint !== "scripts/desktop.js" || !/^\.next(?:-[a-zA-Z0-9-]+)?$/.test(manifest.distDirectory) ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceHash)) throw new Error("Desktop package does not match this runtime");
  for (const name of ["server.js", "scripts/desktop.js", `${manifest.distDirectory}/BUILD_ID`, "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    if (!files.has(`aro/${name}`)) throw new Error("Desktop archive is incomplete");
  }
  if (dryRun) return { directory: target, version: manifest.version, dryRun: true, writes: false };
  await mkdir(target, { mode: 0o700 });
  for (const [name, file] of files) {
    const path = join(target, name.slice(4));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, new Uint8Array(await file.arrayBuffer()), { flag: "wx", mode: 0o600 });
  }
  return { directory: target, version: manifest.version, dryRun: false, writes: true };
}

export async function desktopInstallCommand(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--archive", "--url", "--sha256", "--directory", "--dry-run"].includes(key) || Object.hasOwn(options, key)) {
      throw new Error("Invalid desktop installer option");
    }
    options[key] = key === "--dry-run" ? true : args[++index];
  }
  if (Boolean(options["--archive"]) === Boolean(options["--url"]) || !options["--sha256"] || !options["--directory"]) {
    throw new Error("Desktop install requires --archive FILE or --url HTTPS_URL, --sha256 HASH and --directory NEW_DIRECTORY");
  }
  let bytes;
  if (options["--archive"]) bytes = await readFile(resolve(options["--archive"]));
  else {
    const url = new URL(options["--url"]);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use an HTTPS archive URL without credentials");
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || new URL(response.url).protocol !== "https:") throw new Error("Desktop archive download failed");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024 * 1024) { await reader.cancel(); throw new Error("Desktop archive too large"); }
      chunks.push(value);
    }
    bytes = Buffer.concat(chunks);
  }
  return installDesktop(bytes, options["--sha256"],
    options["--directory"], Boolean(options["--dry-run"]));
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await desktopInstallCommand(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
