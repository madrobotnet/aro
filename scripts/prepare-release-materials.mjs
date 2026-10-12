import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNative } from "../distribution/app/native.mjs";
import { assetPrefix, digest, safe, sha } from "../distribution/release/assets.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const originalWidth = "2672ae17e3d91c246546bf3d56e78c95570eec79381ec143f41d45ec498bccab";
const json = value => `${JSON.stringify(value, null, 2)}\n`;
export async function run(args, options = {}) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", ...options });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  assert.equal(code, 0, `${args[0]} failed: ${stderr}`);
  return stdout;
}
async function* files(root, prefix = "") {
  for (const entry of (await readdir(resolve(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* files(root, path);
    else if (entry.isFile()) yield path;
    // Physical files own bytes; symlinks are not traversed into another tree.
  }
}
let widthFiles;
export async function replacementFiles() {
  if (widthFiles) return widthFiles;
  const recipe = JSON.parse(await readFile(resolve(repository, "distribution/cli/eastasianwidth-replacement.json")));
  const result = new Map();
  for (const file of recipe.files) {
    const bytes = await readFile(resolve(repository, "distribution/cli/width-inputs", file.path));
    assert.equal(sha(bytes), file.sha256, `Replacement input changed: ${file.path}`);
    result.set(file.path, bytes);
  }
  const { from, to } = recipe.generatorAdaptation;
  const generator = result.get("generate.mjs").toString();
  assert.equal(generator.split(from).length, 2);
  result.set("generate.mjs", Buffer.from(generator.replace(from, to)));
  // The old candidate README describes private tests. Deliver the portable
  // recipient instructions instead, without altering the pinned source input.
  const rebuild = await readFile(resolve(repository, "distribution/cli/eastasianwidth-REBUILD.md"));
  result.set("README.md", rebuild);
  result.set("REBUILD.md", rebuild);
  result.set("package.json", Buffer.from(json(recipe.package)));
  result.set("REPLACEMENT.json", Buffer.from(json({
    schemaVersion: 1, kind: recipe.kind, original: {
      name: recipe.original.name, version: recipe.original.version,
      implementationSHA256: recipe.original.implementationSHA256, permissionCleared: false,
    },
    package: recipe.package, inputs: recipe.files,
    adaptations: ["Portable generator output directory", "Portable recipient README"],
  })));
  for (const bytes of result.values()) assert(!/\/home\/ubuntu\/|\.omo\/evidence\//.test(bytes.toString()), "Private replacement locator");
  widthFiles = result;
  return result;
}
export async function replaceWidth(tree) {
  const root = await realpath(tree);
  const targets = [];
  for await (const path of files(root)) {
    if (basename(path) !== "package.json") continue;
    const text = await readFile(resolve(root, path), "utf8");
    // Source archives include intentionally malformed package.json fixtures.
    // Inspect only actual declarations of the package being replaced.
    if (!/"name"\s*:\s*"eastasianwidth"/.test(text)) continue;
    const metadata = JSON.parse(text);
    if (metadata.name !== "eastasianwidth") continue;
    assert.equal(metadata.version, "0.2.0", "Unexpected width package version");
    const target = dirname(path);
    assert.equal((await digest(resolve(root, target, "eastasianwidth.js"))).sha256, originalWidth, "Unexpected original width implementation");
    targets.push(target);
  }
  const replacements = await replacementFiles();
  for (const target of targets) {
    await rm(resolve(root, target), { recursive: true });
    for (const [path, bytes] of replacements) {
      const output = resolve(root, target, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes, { flag: "wx" });
    }
  }
  return targets.map(path => ({ path, originalSha256: originalWidth,
    replacementSha256: sha(replacements.get("index.cjs")) }));
}
export async function assertNoOriginalWidth(tree) {
  for await (const path of files(tree)) {
    assert.notEqual((await digest(resolve(tree, path))).sha256, originalWidth, `Original width remains: ${path}`);
  }
}
export async function archiveTree(tree, output) {
  // GNU tar + gzip with fixed metadata: streaming and deterministic.
  const tar = Bun.spawn(["tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0",
    "--numeric-owner", "--format=gnu", "-cf", "-", "-C", tree, "."], { stdout: "pipe", stderr: "pipe" });
  const gzip = Bun.spawn(["gzip", "-n", "-c"], { stdin: tar.stdout, stdout: "pipe", stderr: "pipe" });
  const results = await Promise.all([
    pipeline(Readable.fromWeb(gzip.stdout), createWriteStream(output, { flags: "wx" })),
    tar.exited, gzip.exited, new Response(tar.stderr).text(), new Response(gzip.stderr).text(),
  ]);
  assert.equal(results[1], 0, results[3]); assert.equal(results[2], 0, results[4]);
}

async function materialIO(out, records) {
  const save = async (path, bytes, metadata = {}) => {
    safe(path);
    const destination = resolve(out, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    const row = { ...metadata, path, bytes: bytes.length, sha256: sha(bytes) };
    records.push(row);
    return row;
  };
  const download = async (url, path, metadata = {}) => {
    safe(path);
    assert.equal(new URL(url).protocol, "https:", "Sources require HTTPS");
    const destination = resolve(out, path);
    await mkdir(dirname(destination), { recursive: true });
    const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
    assert(response.ok, `HTTP ${response.status}: ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: "wx" }));
    const actual = await digest(destination);
    if (metadata.sha256) assert.equal(actual.sha256, metadata.sha256, `Source checksum mismatch: ${url}`);
    if (metadata.bytes !== undefined) assert.equal(actual.bytes, metadata.bytes, `Source size mismatch: ${url}`);
    if (metadata.integrity) {
      const [algorithm, expected] = metadata.integrity.split("-");
      const hash = createHash(algorithm);
      for await (const chunk of createReadStream(destination)) hash.update(chunk);
      assert.equal(hash.digest("base64"), expected, `Source integrity mismatch: ${url}`);
    }
    const row = { ...metadata, url, path, ...actual };
    records.push(row);
    return row;
  };
  return { save, download };
}

async function prepareCLI(root, out, architecture) {
  const records = [], targets = [];
  const { save, download } = await materialIO(out, records);
  const recipe = JSON.parse(await readFile(resolve(repository, "distribution/cli/components.json")));
  const cpu = { amd64: "x64", arm64: "arm64" }[architecture];
  const machine = { amd64: "x86_64", arm64: "aarch64" }[architecture];
  const ptyName = `@lydell/node-pty-linux-${cpu}`;
  const ptyPackage = JSON.parse(await readFile(resolve(root, "usr/local/install/global/node_modules", ptyName, "package.json")));
  assert.equal(ptyPackage.name, ptyName);
  assert.equal(ptyPackage.version, "1.1.0");
  const ptyRegistry = await download(`https://registry.npmjs.org/${ptyName}/1.1.0`, "sources/node-pty-registry.json", { component: ptyName });
  assert.equal(JSON.parse(await readFile(resolve(out, ptyRegistry.path))).gitHead, "0407346d07b22729198c26d564011d96fca33297", "Unrecognized platform node-pty source");
  const vendor = `usr/local/install/global/node_modules/@openai/codex-linux-${cpu}/vendor/${machine}-unknown-linux-musl`;
  const voice = `${vendor}/codex-resources/voice`;
  const manifest = JSON.parse(await readFile(resolve(root, voice, "manifest.json")));
  assert.equal(manifest.appTarget, `${machine}-unknown-linux-musl`);
  assert.equal(manifest.voiceTarget, `${machine}-unknown-linux-gnu`);
  assert.equal(manifest.appVersion, "0.158.0");
  assert.equal(manifest.buildCommit, "064c6b8c737f5b41d171fdda80bd9ef10ad06eb3");
  for (const [path, expected] of Object.entries(manifest.sha256)) {
    safe(path);
    const identity = await digest(resolve(root, vendor, path));
    assert.equal(identity.sha256, expected, `Delivered Codex manifest mismatch: ${path}`);
    targets.push({ path: `${vendor}/${path}`, ...identity, component: "codex-voice" });
  }
  // Every voice license is retained, independently of collector filename rules.
  for (const path of ["NOTICE.md", "manifest.json", "sources.json", ...(await readdir(resolve(root, voice, "licenses"))).map(name => `licenses/${name}`)]) {
    await save(`notices/voice/${path}`, await readFile(resolve(root, voice, path)), { component: "codex-voice", shippedPath: `${voice}/${path}` });
  }
  const voiceSources = JSON.parse(await readFile(resolve(root, voice, "sources.json"))).sources;
  for (const item of voiceSources) {
    const pinned = recipe.sources.find(source => source.name === item.name);
    assert(pinned && pinned.version === item.version && pinned.url === item.url &&
      pinned.sha256 === item.sha256, `Unrecognized delivered voice source: ${item.name}`);
  }
  const sources = [
    ...voiceSources,
    ...recipe.sources.filter(item => !item.role && !["eastasianwidth", "eastasianwidth-published", "codex-amd64-payload"].includes(item.name))
      .map(item => item.name === "@lydell/node-pty-linux-arm64" ? { ...item, name: ptyName } : item),
    ...recipe.supplementalSources,
  ];
  for (const item of sources) {
    const id = item.name.replaceAll("/", "-").replaceAll("@", "");
    const row = await download(item.url, `sources/${id}.tar.gz`, {
      component: item.name, version: item.version ?? item.revision, sha256: item.sha256,
      ...(item.integrity ? { integrity: item.integrity } : {}),
    });
    const inspection = resolve(out, ".inspection", id);
    await mkdir(inspection, { recursive: true });
    const archive = resolve(out, row.path);
    const names = (await run(["tar", "-tf", archive])).trimEnd().split("\n");
    assert(names.every(name => !name.startsWith("/") && !name.split("/").includes("..")), "Unsafe source archive member");
    await run(["tar", "-xf", archive, "--no-same-owner", "-C", inspection]);
    if (item.name === "keytar") {
      const prebuilds = "usr/local/install/global/node_modules/@github/keytar/prebuilds";
      for await (const path of files(resolve(root, prebuilds))) {
        const actual = await digest(resolve(root, prebuilds, path));
        assert.deepEqual(actual, await digest(resolve(inspection, "package/prebuilds", path)), `Published keytar payload mismatch: ${path}`);
        targets.push({ path: `${prebuilds}/${path}`, ...actual, component: "@github/keytar@7.10.6",
          sourceArchive: row.path, archivePath: `package/prebuilds/${path}` });
      }
    }
    const replacements = await replaceWidth(inspection);
    await assertNoOriginalWidth(inspection);
    if (replacements.length || item.name === "npm") {
      const upstream = { sha256: row.sha256, bytes: row.bytes };
      const preferred = `sources/${id}-preferred.tar.gz`;
      await archiveTree(inspection, resolve(out, preferred));
      await rm(archive);
      Object.assign(row, { path: preferred, upstream, replacements }, await digest(resolve(out, preferred)));
    }
    for await (const path of files(inspection)) {
      if (/(?:^|\/)(?:licen[sc]e|copying|notice|authors|copyright)(?:[._-]|$)/i.test(path) ||
          /^(?:@npmcli\/agent-published|err-code-published|imurmurhash|spdx-exceptions|spdx-license-ids)$/.test(item.name) && /\/(?:README\.md|package\.json)$/.test(path)) {
        await save(`notices/sources/${id}/${path}`, await readFile(resolve(inspection, path)),
          { component: item.name, sourceArchive: row.path, archivePath: path });
      }
    }
    await rm(inspection, { recursive: true });
  }
  await rm(resolve(out, ".inspection"), { recursive: true });
  // Inventory the actual retained native files, including cache and foreign
  // prebuild copies. Directory labels are not substituted for ELF identities.
  for await (const path of files(resolve(root, "usr/local"))) {
    const full = resolve(root, "usr/local", path);
    const handle = await open(full, "r");
    const header = Buffer.alloc(20);
    let length;
    try { length = (await handle.read(header, 0, header.length, 0)).bytesRead; }
    finally { await handle.close(); }
    if (length === 20 && header.subarray(0, 4).toString("hex") === "7f454c46") {
      targets.push({ path: `usr/local/${path}`, ...await digest(full),
        component: "retained-cli-native", elfMachine: header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18) });
    }
  }
  await save("notices/LINKED-LIBRARIES.txt", await readFile(resolve(repository, "distribution/cli/LINKED-LIBRARIES.txt")));
  await download("https://raw.githubusercontent.com/openai/codex/rust-v0.158.0/LICENSE", "notices/Codex-LICENSE", {
    sha256: "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
  });
  const grants = JSON.parse(await readFile(resolve(repository, "distribution/cli/grants.json")));
  for (const item of grants.terms) await download(item.url, `notices/terms/${item.name}.txt`, { sha256: item.sha256, component: item.name });
  for (const [name, url, hash] of [
    ["CC-BY-3.0", "https://creativecommons.org/licenses/by/3.0/legalcode.txt", "e6bc9e9c474700b708f568bac9e5a8a9bcb2b1dad53442f5ba449fcb848b8e76"],
    ["CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt", "a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499"],
  ]) await download(url, `notices/terms/${name}.txt`, { sha256: hash });
  for (const [path, bytes] of await replacementFiles()) await save(`sources/width-preferred/${path}`, bytes, { component: "@aro/eastasianwidth-compat" });
  await writeFile(resolve(out, "manifest.json"), json({ schemaVersion: 1, platform: `linux/${architecture}`, records, targets,
    nativeReplacementVerified: false, originalCompilerIdentityClaimed: false }));
  return targets;
}

export async function prepareReleaseMaterials(options) {
  const { version, revision, platform } = options;
  assetPrefix(version, platform);
  assert.match(revision, /^(?:[a-f0-9]{40}|local)$/);
  const architecture = platform.split("/")[1];
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, { amd64: "x64", arm64: "arm64" }[architecture], "Native preparation required");
  const root = await realpath(resolve(options.root)), out = resolve(options.out);
  assert(root !== "/" && !out.startsWith(root + "/") && !root.startsWith(out + "/") && root !== out, "Owned target and material trees must be disjoint");
  await mkdir(out);
  // Validate exact system source availability before the larger native/runtime
  // acquisitions, so a system inventory failure does not discard that work.
  await run([process.execPath, "--no-env-file", resolve(repository, "scripts/prepare-redistribution-debian.mjs"),
    "--root", root, "--out", resolve(out, "debian")]);
  const replacements = await replaceWidth(root);
  assert(replacements.length, "No original width modules found in target");
  await assertNoOriginalWidth(root);
  for (const owner of ["app", "cli"]) await mkdir(resolve(out, owner));
  const appRecords = [];
  const io = await materialIO(resolve(out, "app"), appRecords);
  const native = await prepareNative({ root: resolve(root, "app/node_modules"), out: resolve(out, "app"), architecture, ...io });
  assert.equal(native.blockers.length, 0, `Native source failures: ${JSON.stringify(native.blockers)}`);
  await io.save("notices/LGPL-REPLACEMENT.md", await readFile(resolve(repository, "distribution/app/LGPL-REPLACEMENT.md")));
  await writeFile(resolve(out, "app/manifest.json"), json({ schemaVersion: 1, native, files: appRecords }));
  const targets = native.distributions.filter(row => row.actual).map(row => ({ path: row.actual.shippedPath,
    bytes: row.actual.bytes, sha256: row.actual.sha256, component: row.component }));
  targets.push(...await prepareCLI(root, resolve(out, "cli"), architecture));
  await run([process.execPath, "--no-env-file", resolve(repository, "scripts/prepare-redistribution-runtime.mjs"),
    "--runtime-root", root, "--architecture", architecture, "--out", resolve(out, "runtime")]);
  const runtime = JSON.parse(await readFile(resolve(out, "runtime/manifest.json")));
  for (const name of ["bun", "node"]) targets.push({ path: `usr/local/bin/${name}`,
    ...await digest(resolve(root, `usr/local/bin/${name}`)), component: name, version: runtime.runtimes[name].version });
  // Recollect after replacement, preserving the established notice contract.
  const collector = resolve(out, ".cli-licenses");
  await run([process.execPath, "--no-env-file", resolve(repository, "scripts/collect-image-licenses.mjs"),
    "--root", resolve(root, "usr/local"), "--out", collector]);
  const inventory = JSON.parse(await readFile(resolve(collector, "inventory.json")));
  inventory.sourceRoot = "/usr/local";
  await writeFile(resolve(collector, "inventory.json"), json(inventory));
  for (const destination of ["app/licenses/cli", "usr/share/aro/licenses/cli"]) {
    await rm(resolve(root, destination), { recursive: true });
    await cp(collector, resolve(root, destination), { recursive: true });
  }
  await rm(collector, { recursive: true });
  for (const owner of ["app", "cli", "runtime", "debian"]) {
    await cp(resolve(out, owner, "notices"), resolve(root, "usr/share/aro/licenses", `${owner}-sources`), { recursive: true });
  }
  await mkdir(resolve(out, "release"));
  await writeFile(resolve(out, "release/width-replacements.json"), json(replacements));
  const selected = [];
  for (const owner of ["app", "cli", "runtime", "debian", "release"]) {
    for await (const path of files(resolve(out, owner))) {
      safe(path);
      selected.push({ owner, path, ...await digest(resolve(out, owner, path)),
        mode: ((await stat(resolve(out, owner, path))).mode & 0o111) ? 0o755 : 0o644 });
    }
  }
  for (const target of targets) assert.deepEqual(await digest(resolve(root, safe(target.path))), {
    bytes: target.bytes, sha256: target.sha256,
  }, `Target changed during acquisition: ${target.path}`);
  const manifest = { schemaVersion: 1, kind: "aro-selected-materials", version, revision, platform,
    nativeRelinkVerified: false, targets, files: selected };
  const text = json(manifest);
  assert(!/\/home\/ubuntu\/|\.omo\/evidence\//.test(text), "Private material locator");
  await writeFile(resolve(out, "manifest.json"), text, { flag: "wx" });
  await writeFile(resolve(root, "usr/share/aro/licenses/materials.json"), text);
  await writeFile(resolve(root, "usr/share/aro/licenses/materials.sha256"), `${sha(text)}  materials.json\n`);
  return { materialManifestSha256: sha(text), files: selected.length, targets: targets.length };
}

if (import.meta.main) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]?.slice(2);
      assert(args[i].startsWith("--") && ["root", "out", "version", "revision", "platform"].includes(key) &&
        !options[key] && args[i + 1] && !args[i + 1].startsWith("--"), "Invalid material argument");
      options[key] = args[i + 1];
    }
    for (const key of ["root", "out", "version", "revision", "platform"]) assert(options[key], `Required --${key}`);
    console.log(JSON.stringify(await prepareReleaseMaterials(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
