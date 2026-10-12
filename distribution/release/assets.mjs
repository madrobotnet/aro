import assert from "node:assert/strict";
import { releasePrefix } from "../../scripts/release-names.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, readFile, mkdir, open, writeFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";

export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export async function digest(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}
export function safe(path) {
  assert(typeof path === "string" && path.length && !path.includes("\\") &&
    !/[\x00-\x1f\x7f]/.test(path) &&
    path.split("/").every(p => p && p !== "." && p !== ".."), `Unsafe path: ${path}`);
  assert(!(/(^|\/)(history|original-archives)(\/|$)/.test(path) && /\.(?:tar(?:\.(?:gz|xz|bz2|zst))?|tgz|zip)$/.test(path)) &&
    !/^sources\/node\.tar\.gz$/.test(path), `Private historical archive: ${path}`);
  return path;
}
async function checkedPath(root, path) {
  safe(path);
  const file = resolve(root, path);
  assert((await lstat(file)).isFile(), `Not a regular file: ${file}`);
  assert.equal(await realpath(file), file, `Symlink path: ${file}`);
  assert(!relative(root, file).startsWith(".."), `Escaped root: ${file}`);
  return file;
}
function header(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "ascii");
  for (const [offset, length, value] of [[100,8,0o644],[108,8,0],[116,8,0],[124,12,size],[136,12,0]]) {
    h.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
  }
  h.fill(32, 148, 156); h[156] = 48;
  h.write("ustar\0", 257); h.write("00", 263);
  const checksum = h.reduce((sum, b) => sum + b, 0);
  h.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}
export function assetPrefix(version, platform) {
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), "Unsupported source version");
  assert(["linux/amd64", "linux/arm64"].includes(platform), "Unsupported source platform");
  return `${releasePrefix(version)}-${version}-sources-${platform.replace("/", "-")}`;
}
export async function prepareAssets(options) {
  const prefix = assetPrefix(options.version, options.platform);
  assert.match(options.revision, /^(?:[a-f0-9]{40}|local)$/);
  assert.match(options.seal, /^[a-f0-9]{64}$/);
  const limit = Number(options.limit ?? 1900000000);
  assert(Number.isSafeInteger(limit) && limit >= 4096 && limit < 2000000000);
  const root = await realpath(resolve(options.materials));
  const raw = await readFile(await checkedPath(root, "manifest.json"));
  assert.equal(sha(raw), options.seal, "Material manifest seal mismatch");
  const manifest = JSON.parse(raw);
  assert.equal(manifest.schemaVersion, 1);
  assert(["aro-selected-materials", "irang-selected-materials"].includes(manifest.kind), "Unsupported material kind");
  for (const key of ["version", "revision", "platform"]) assert.equal(manifest[key], options[key], `Material ${key} mismatch`);
  assert(Array.isArray(manifest.files) && manifest.files.length, "Empty selected materials");
  const out = resolve(options.out);
  assert.equal(await realpath(dirname(out)), dirname(out), "Output parent must not contain symlinks");
  assert(out !== root && !out.startsWith(root + "/") && !root.startsWith(out + "/"), "Output overlaps inputs");
  const unique = new Map(), associations = [], paths = new Set();
  const records = [...manifest.files, { owner: "release", path: "materials.json", bytes: raw.length, sha256: sha(raw) }];
  for (const row of records) {
    assert(["app", "cli", "runtime", "debian", "release"].includes(row.owner), "Unknown material owner");
    safe(row.path);
    const key = row.owner + "/" + row.path;
    assert(!paths.has(key), `Duplicate destination: ${key}`); paths.add(key);
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0);
    assert(row.mode === undefined || [0o644, 0o755].includes(row.mode), "Unsafe material mode");
    const file = await checkedPath(root, key === "release/materials.json" ? "manifest.json" : key);
    const actual = await digest(file);
    assert.equal(actual.sha256, row.sha256, `Integrity mismatch: ${key}`);
    assert.equal(actual.bytes, row.bytes, `Size mismatch: ${key}`);
    if (unique.has(row.sha256)) assert.equal(unique.get(row.sha256).bytes, row.bytes);
    else unique.set(row.sha256, { file, bytes: row.bytes });
    associations.push(row);
  }
  await mkdir(out); // Exclusive: existing assets are never overwritten.
  const assets = [], blobs = {};
  let handle, position = 0, name;
  const close = async () => {
    if (!handle) return;
    await handle.writeFile(Buffer.alloc(1024)); await handle.close();
    const receipt = await digest(resolve(out, name));
    assert(receipt.bytes < limit);
    assets.push({ name, ...receipt }); handle = undefined;
  };
  const start = async () => {
    name = `${prefix}-${String(assets.length + 1).padStart(4, "0")}.tar`;
    handle = await open(resolve(out, name), "wx"); position = 0;
  };
  for (const [hash, blob] of [...unique].sort(([a], [b]) => a < b ? -1 : 1)) {
    const pieces = [];
    const archivedHash = createHash("sha256");
    const maximum = Math.floor((limit - 2048) / 512) * 512;
    for (let offset = 0, part = 0; offset < blob.bytes || (blob.bytes === 0 && part === 0); part++) {
      const bytes = Math.min(maximum, blob.bytes - offset);
      const padded = Math.ceil(bytes / 512) * 512;
      if (handle && position + 512 + padded + 1024 >= limit) await close();
      if (!handle) await start();
      const member = `${hash}/${part}`;
      await handle.writeFile(header(member, bytes)); position += 512;
      const pieceHash = createHash("sha256");
      if (bytes) for await (const chunk of createReadStream(blob.file, { start: offset, end: offset + bytes - 1 })) {
        pieceHash.update(chunk); archivedHash.update(chunk); await handle.writeFile(chunk);
      }
      const pieceSha256 = pieceHash.digest("hex");
      pieces.push({ asset: name, member, offset: position, bytes, sha256: pieceSha256 });
      await handle.writeFile(Buffer.alloc(padded - bytes)); position += padded; offset += bytes;
      if (!blob.bytes) break;
    }
    assert.equal(archivedHash.digest("hex"), hash, "Input changed during archiving");
    blobs[hash] = { bytes: blob.bytes, pieces };
  }
  await close();
  const index = { schemaVersion: 2, version: options.version, revision: options.revision,
    platform: options.platform, materialManifestSha256: options.seal,
    sourcePublicationVerified: false, nativeRelinkVerified: false,
    assets, blobs, associations };
  const text = JSON.stringify(index) + "\n";
  const indexName = prefix + "-index.json";
  await writeFile(resolve(out, indexName), text, { flag: "wx", mode: 0o444 });
  await writeFile(resolve(out, indexName + ".sha256"), `${sha(text)}  ${indexName}\n`, { flag: "wx", mode: 0o444 });
  for (const name of ["assets.mjs", "restore.mjs"]) {
    const helper = await readFile(new URL(name, import.meta.url), "utf8");
    await writeFile(resolve(out, name), helper.replace("../../scripts/release-names.mjs", "./release-names.mjs"), { flag: "wx" });
  }
  await writeFile(resolve(out, "release-names.mjs"), await readFile(new URL("../../scripts/release-names.mjs", import.meta.url)), { flag: "wx" });
  return { assets: assets.length, associations: associations.length, unique: unique.size,
    indexName, indexSha256: sha(text), materialManifestSha256: options.seal };
}
