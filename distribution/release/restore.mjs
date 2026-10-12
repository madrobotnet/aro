import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, chmod, lstat, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assetPrefix, digest, safe, sha } from "./assets.mjs";

async function regular(root, name) {
  safe(name);
  const path = resolve(root, name);
  assert((await lstat(path)).isFile() && await realpath(path) === path, "Source asset is not a regular unlinked file");
  return path;
}

// Public entry point for streaming release verification, independent of the
// installer's bounded text screen. The authenticated index hash is mandatory.
export async function verifySourceAssets(directory, indexName, indexSha256, expected = {}) {
  const root = await realpath(resolve(directory));
  assert.match(indexSha256, /^[a-f0-9]{64}$/);
  const text = await readFile(await regular(root, indexName));
  assert.equal(sha(text), indexSha256, "Index seal mismatch");
  const index = JSON.parse(text);
  assert.equal(index.schemaVersion, 2);
  const prefix = assetPrefix(index.version, index.platform);
  assert.equal(indexName, `${prefix}-index.json`, "Architecture-qualified index name mismatch");
  assert.match(index.revision, /^(?:[a-f0-9]{40}|local)$/);
  assert.match(index.materialManifestSha256, /^[a-f0-9]{64}$/);
  for (const [key, value] of Object.entries(expected)) assert.equal(index[key], value, `Source ${key} mismatch`);
  assert(Array.isArray(index.assets) && index.assets.length, "Empty source assets");
  const assets = new Map();
  for (const [i, asset] of index.assets.entries()) {
    assert.equal(asset.name, `${prefix}-${String(i + 1).padStart(4, "0")}.tar`);
    assert(Number.isSafeInteger(asset.bytes) && asset.bytes >= 1536 && asset.bytes < 2000000000);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    const path = await regular(root, asset.name);
    assert.deepEqual(await digest(path), { bytes: asset.bytes, sha256: asset.sha256 }, "Source archive integrity mismatch");
    assets.set(asset.name, { ...asset, path });
  }
  const ranges = new Map(index.assets.map(asset => [asset.name, []]));
  for (const [hash, blob] of Object.entries(index.blobs)) {
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(blob.bytes) && blob.bytes >= 0);
    assert(Array.isArray(blob.pieces) && blob.pieces.length);
    let size = 0;
    const whole = createHash("sha256");
    for (const [part, piece] of blob.pieces.entries()) {
      const asset = assets.get(piece.asset);
      assert(asset, "Unknown piece archive");
      assert.equal(piece.member, `${hash}/${part}`);
      assert(Number.isSafeInteger(piece.offset) && piece.offset >= 512 && piece.offset % 512 === 0, "Invalid piece offset");
      assert(Number.isSafeInteger(piece.bytes) && piece.bytes >= 0 &&
        piece.offset + Math.ceil(piece.bytes / 512) * 512 <= asset.bytes - 1024, "Piece outside archive");
      assert.match(piece.sha256, /^[a-f0-9]{64}$/);
      ranges.get(piece.asset).push([piece.offset - 512, piece.offset + Math.ceil(piece.bytes / 512) * 512]);
      const partHash = createHash("sha256");
      if (piece.bytes) for await (const chunk of createReadStream(asset.path, {
        start: piece.offset, end: piece.offset + piece.bytes - 1,
      })) { partHash.update(chunk); whole.update(chunk); }
      assert.equal(partHash.digest("hex"), piece.sha256, "Source piece integrity mismatch");
      size += piece.bytes;
    }
    assert.equal(size, blob.bytes, "Source blob size mismatch");
    assert.equal(whole.digest("hex"), hash, "Source blob integrity mismatch");
  }
  for (const [name, spans] of ranges) {
    let end = 0;
    for (const [start, next] of spans.sort((a, b) => a[0] - b[0])) {
      assert.equal(start, end, "Overlapping or unindexed source member");
      end = next;
    }
    assert.equal(end + 1024, assets.get(name).bytes, "Unindexed archive bytes");
  }
  const paths = new Set(), used = new Set();
  assert(Array.isArray(index.associations) && index.associations.length);
  for (const row of index.associations) {
    assert(["app", "cli", "runtime", "debian", "release"].includes(row.owner), "Unknown source owner");
    safe(row.path);
    const path = `${row.owner}/${row.path}`;
    assert(!paths.has(path), "Duplicate source destination"); paths.add(path);
    assert.equal(index.blobs[row.sha256]?.bytes, row.bytes, "Source association mismatch");
    assert(row.mode === undefined || [0o644, 0o755].includes(row.mode), "Unsafe source mode");
    used.add(row.sha256);
  }
  assert.equal(used.size, Object.keys(index.blobs).length, "Unowned source blob");
  const material = index.associations.find(row => row.owner === "release" && row.path === "materials.json");
  assert.equal(material?.sha256, index.materialManifestSha256, "Embedded material seal association mismatch");
  const chunks = [];
  for (const piece of index.blobs[material.sha256].pieces) {
    if (piece.bytes) for await (const chunk of createReadStream(assets.get(piece.asset).path, {
      start: piece.offset, end: piece.offset + piece.bytes - 1,
    })) chunks.push(chunk);
  }
  const manifest = JSON.parse(Buffer.concat(chunks));
  assert.equal(manifest.schemaVersion, 1);
  assert(["aro-selected-materials", "irang-selected-materials"].includes(manifest.kind), "Unsupported material kind");
  for (const key of ["version", "revision", "platform"]) assert.equal(manifest[key], index[key], `Sealed material ${key} mismatch`);
  assert.deepEqual(index.associations.filter(row => row !== material), manifest.files, "Sealed selected-file associations differ");
  return index;
}

export async function restoreAssets(directory, indexName, indexSha256, output) {
  const index = await verifySourceAssets(directory, indexName, indexSha256);
  const root = await realpath(resolve(directory));
  const out = resolve(output);
  assert.equal(await realpath(dirname(out)), dirname(out), "Output parent contains symlinks");
  await mkdir(out); // Never overwrite or merge into an existing tree.
  for (const row of index.associations) {
    const target = resolve(out, row.owner, row.path);
    await mkdir(dirname(target), { recursive: true });
    const file = await open(target, "wx");
    try {
      for (const piece of index.blobs[row.sha256].pieces) {
        if (piece.bytes) for await (const chunk of createReadStream(resolve(root, piece.asset), {
          start: piece.offset, end: piece.offset + piece.bytes - 1,
        })) await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    assert.deepEqual(await digest(target), { bytes: row.bytes, sha256: row.sha256 });
    await chmod(target, row.mode ?? 0o644);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 6, "Usage: node restore.mjs DIRECTORY INDEX_NAME INDEX_SHA256 NEW_OUTPUT");
    await restoreAssets(...process.argv.slice(2));
    console.log("RESTORED_VERIFIED_SOURCE_PATHS");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
