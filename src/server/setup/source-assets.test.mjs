import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, access, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assetPrefix, prepareAssets, sha, safe, digest } from "../../../distribution/release/assets.mjs";
import { restoreAssets, verifySourceAssets } from "../../../distribution/release/restore.mjs";
import { replacementFiles, replaceWidth, archiveTree } from "../../../scripts/prepare-release-materials.mjs";

const temporaryParent = process.platform === "darwin" ? await realpath(tmpdir()) : tmpdir();
async function fixture(platform = "linux/arm64", version = "2.4.0") {
  const root = await mkdtemp(join(temporaryParent, "source-assets-"));
  const options = { version, revision: "a".repeat(40), platform, limit: 8192,
    materials: join(root, "materials"), out: join(root, "out") };
  const content = Buffer.alloc(10000, 65);
  const row = { path: "sources/input", sha256: sha(content), bytes: content.length, mode: 0o644 };
  const rows = ["app", "cli", "runtime"].map(owner => ({ owner, ...row }));
  rows.push({ owner: "debian", path: "sources/empty", bytes: 0, sha256: sha("") });
  for (const item of rows) {
    await mkdir(join(options.materials, item.owner, "sources"), { recursive: true });
    await writeFile(join(options.materials, item.owner, item.path), item.bytes ? content : "");
  }
  const manifest = { schemaVersion: 1, kind: version === "2.3.2" ? "irang-selected-materials" : "aro-selected-materials",
    version: options.version, revision: options.revision, platform, targets: [], files: rows };
  const seal = async () => {
    const text = JSON.stringify(manifest);
    await writeFile(join(options.materials, "manifest.json"), text);
    options.seal = sha(text);
  };
  await seal();
  return { root, options, row, manifest, seal };
}

for (const version of ["2.3.2", "2.4.0"]) {
for (const platform of ["linux/amd64", "linux/arm64"]) {
  test(`${version} ${platform} partitions deterministically and restores duplicate source ownership`, async () => {
    const { root, options, row } = await fixture(platform, version);
    try {
      const result = await prepareAssets(options);
      const first = await readFile(join(options.out, result.indexName), "utf8");
      await prepareAssets({ ...options, out: join(root, "second") });
      expect(await readFile(join(root, "second", result.indexName), "utf8")).toBe(first);
      const index = await verifySourceAssets(options.out, result.indexName, sha(first), {
        materialManifestSha256: options.seal, platform, version, revision: options.revision,
      });
      expect(result.indexName).toBe(`${version === "2.3.2" ? "irang" : "aro"}-${version}-sources-${platform.replace("/", "-")}-index.json`);
      expect(index.assets.every(a => a.bytes < 8192 && a.name.includes(platform.replace("/", "-")))).toBe(true);
      expect(index.blobs[row.sha256].pieces.length).toBe(2);
      expect(index.associations.filter(r => r.sha256 === row.sha256).map(r => r.owner).sort()).toEqual(["app", "cli", "runtime"]);
      expect(index.sourcePublicationVerified).toBe(false);
      const child = Bun.spawn(["node", join(options.out, "restore.mjs"),
        options.out, result.indexName, sha(first), join(root, "restored")], { stdout: "pipe", stderr: "pipe" });
      const [code, errors, output] = await Promise.all([child.exited,
        new Response(child.stderr).text(), new Response(child.stdout).text()]);
      expect({ code, errors }).toEqual({ code: 0, errors: "" });
      expect(output).toContain("RESTORED_VERIFIED_SOURCE_PATHS");
      expect(await readFile(join(root, "restored/cli/sources/input"))).toEqual(Buffer.alloc(10000, 65));
      expect((await digest(join(root, "restored/release/materials.json"))).sha256).toBe(options.seal);
      expect((await readFile(join(root, "restored/debian/sources/empty"))).length).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
}

for (const version of ["2.3.2", "2.4.0"]) {
test(`${version} release checksums validates source indexes beyond outer file hashes`, async () => {
  const { root, options } = await fixture("linux/arm64", version);
  try {
    const result = await prepareAssets(options);
    const check = async () => {
      const names = (await readdir(options.out)).filter(name => name !== "SHA256SUMS");
      const sums = await Promise.all(names.map(async name =>
        `${sha(await readFile(join(options.out, name)))}  ${name}\n`));
      await writeFile(join(options.out, "SHA256SUMS"), sums.join(""));
      const child = Bun.spawn(["bun", "--no-env-file",
        join(import.meta.dir, "../../../scripts/verify-release.mjs"),
        "checksums", "--root", options.out], { stdout: "pipe", stderr: "pipe" });
      const [code, output, errors] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { code, output, errors };
    };
    expect((await check()).code).toBe(0);
    const indexPath = join(options.out, result.indexName);
    const index = JSON.parse(await readFile(indexPath));
    index.associations[0].path = "../escape";
    await chmod(indexPath, 0o644);
    await writeFile(indexPath, JSON.stringify(index));
    expect((await check()).code).not.toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
}

test("rejects corrupted selected input before creating output", async () => {
  const { root, options } = await fixture();
  try {
    await writeFile(join(options.materials, "app/sources/input"), "corrupt");
    await assert.rejects(prepareAssets(options), /Integrity mismatch/);
    await assert.rejects(access(options.out), { code: "ENOENT" });
    expect(await readFile(join(options.materials, "runtime/sources/input"))).toEqual(Buffer.alloc(10000, 65));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects material seal and target identity mismatches", async () => {
  const { root, options } = await fixture();
  try {
    await assert.rejects(prepareAssets({ ...options, seal: "f".repeat(64) }), /seal mismatch/);
    await assert.rejects(prepareAssets({ ...options, platform: "linux/amd64" }), /platform mismatch/);
    await assert.rejects(prepareAssets({ ...options, revision: "b".repeat(40) }), /revision mismatch/);
    await assert.rejects(prepareAssets({ ...options, version: "2.4.0-rc" }), /Unsupported source version/);
    await assert.rejects(access(options.out), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects duplicate owners, unknown owners, unsafe modes and source symlinks", async () => {
  const { root, options, manifest, seal } = await fixture();
  try {
    manifest.files.push(manifest.files[0]); await seal();
    await assert.rejects(prepareAssets(options), /Duplicate destination/);
    manifest.files.pop(); manifest.files[0].owner = "private"; await seal();
    await assert.rejects(prepareAssets(options), /Unknown material owner/);
    manifest.files[0].owner = "app"; manifest.files[0].mode = 0o4755; await seal();
    await assert.rejects(prepareAssets(options), /Unsafe material mode/);
    manifest.files[0].mode = 0o644; await seal();
    await rm(join(options.materials, "app/sources/input"));
    await symlink(join(options.materials, "cli/sources/input"), join(options.materials, "app/sources/input"));
    await assert.rejects(prepareAssets(options), /Not a regular file/);
    await assert.rejects(access(options.out), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("rejects overlap without modifying the selected tree", async () => {
  const { root, options } = await fixture();
  try {
    await assert.rejects(prepareAssets({ ...options, out: join(options.materials, "output") }), /overlaps/);
    expect((await digest(join(options.materials, "manifest.json"))).sha256).toBe(options.seal);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects corrupted downloaded archives before creating restored output", async () => {
  const { root, options } = await fixture();
  try {
    const result = await prepareAssets(options);
    const index = JSON.parse(await readFile(join(options.out, result.indexName)));
    await writeFile(join(options.out, index.assets[0].name), "corrupt");
    const output = join(root, "restored");
    await assert.rejects(restoreAssets(options.out, result.indexName, result.indexSha256, output), /integrity mismatch/);
    await assert.rejects(access(output), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects malformed authenticated indexes and mismatched embedded image seals", async () => {
  const { root, options } = await fixture();
  try {
    const result = await prepareAssets(options);
    const indexPath = join(options.out, result.indexName);
    const original = JSON.parse(await readFile(indexPath));
    await chmod(indexPath, 0o644); // Deliberately corrupt an owned downloaded fixture.
    await assert.rejects(verifySourceAssets(options.out, result.indexName, result.indexSha256, {
      materialManifestSha256: "f".repeat(64),
    }), /materialManifestSha256 mismatch/);
    const mutations = [
      index => { index.associations[0].path = "../escape"; },
      index => { index.associations.push(index.associations[0]); },
      index => { Object.values(index.blobs)[0].pieces[0].offset = -1; },
      index => { Object.values(index.blobs)[0].pieces[0].sha256 = "f".repeat(64); },
      index => { Object.values(index.blobs)[0].pieces[0].asset = "../secret"; },
      index => { index.associations[0].mode = 0o7777; },
      index => { index.materialManifestSha256 = "f".repeat(64); },
      index => { index.associations.shift(); }, // Other owners still use this blob.
    ];
    for (const mutate of mutations) {
      const index = structuredClone(original); mutate(index);
      const text = JSON.stringify(index); await writeFile(indexPath, text);
      await assert.rejects(restoreAssets(options.out, result.indexName, sha(text), join(root, "restored")));
      await assert.rejects(access(join(root, "restored")), { code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects traversal and private raw containing archives", () => {
  for (const path of ["/absolute", "../secret", "a/../b", "a\\b", "sources/node.tar.gz", "history/raw.tar.gz", "a\nb"]) {
    expect(() => safe(path)).toThrow();
  }
  expect(safe("notices/history/esbuild-mit.txt")).toBe("notices/history/esbuild-mit.txt");
  expect(assetPrefix("2.3.2", "linux/amd64")).not.toBe(assetPrefix("2.3.2", "linux/arm64"));
});

test.skipIf(process.platform !== "linux")("portable replacement regenerates pinned ranges without private producer paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "width-source-"));
  try {
    const materials = await replacementFiles();
    const metadata = JSON.parse(materials.get("package.json"));
    expect(metadata.name).toBe("@aro/eastasianwidth-compat");
    expect(metadata.version).toBe("0.2.0-aro.1");
    expect(metadata.aroReplaces).toBeDefined();
    for (const [path, bytes] of materials) {
      await mkdir(join(root, dirname(path)), { recursive: true });
      await writeFile(join(root, path), bytes);
      expect(bytes.toString()).not.toMatch(/\/home\/ubuntu\/|\.omo\/evidence\//);
    }
    await mkdir(join(root, "generated"));
    const child = Bun.spawn([process.execPath, "--no-env-file", "generate.mjs", "--input", join(root, "sources/EastAsianWidth-6.0.0.txt")], {
      cwd: root, env: { PATH: process.env.PATH, ARO_WIDTH_OUTPUT: join(root, "generated") }, stdout: "pipe", stderr: "pipe",
    });
    const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect({ code, errors }).toEqual({ code: 0, errors: "" });
    expect((await digest(join(root, "generated/ranges.json"))).sha256).toBe("0e8a6564a9bae1f35ae3065b8c9e4c0b879720d1ad1547151035d09367efe609");
    const { default: width } = await import(join(root, "index.cjs"));
    expect({ width: width.eastAsianWidth("①"), length: width.length("①a"), slice: width.slice("abc", 0, 2) })
      .toEqual({ width: "A", length: 3, slice: "ab" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("width replacement ignores malformed unrelated fixtures and rejects changed originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "width-source-"));
  try {
    await writeFile(join(root, "package.json"), "{ invalid fixture");
    expect(await replaceWidth(root)).toEqual([]);
    await mkdir(join(root, "package"));
    await writeFile(join(root, "package/package.json"), JSON.stringify({ name: "eastasianwidth", version: "0.2.0" }));
    await writeFile(join(root, "package/eastasianwidth.js"), "changed");
    await assert.rejects(replaceWidth(root), /Unexpected original width implementation/);
    expect(await readFile(join(root, "package/eastasianwidth.js"), "utf8")).toBe("changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux" || !Bun.which("gzip"))("preferred-source tar creation streams deterministic complete files", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-tar-"));
  try {
    await mkdir(join(root, "tree"));
    await writeFile(join(root, "tree/input"), "preferred source");
    await archiveTree(join(root, "tree"), join(root, "one.tar.gz"));
    await archiveTree(join(root, "tree"), join(root, "two.tar.gz"));
    expect(await digest(join(root, "one.tar.gz"))).toEqual(await digest(join(root, "two.tar.gz")));
    const members = await new Bun.Archive(await readFile(join(root, "one.tar.gz"))).files();
    const input = members.get("input") ?? members.get("./input");
    expect(await input.text()).toBe("preferred source");
  } finally { await rm(root, { recursive: true, force: true }); }
});
