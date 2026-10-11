import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// This prepares private build inputs, not a release or a legal approval.
if (!process.versions.bun) throw new Error("Run this preparation with Bun");
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!["--root", "--out", "--cache", "--inventory", "--eastasianwidth-replacement"].includes(args[i]) || !args[i + 1] || options[args[i]]) {
    throw new Error("Usage: bun scripts/prepare-redistribution-cli.mjs --root <usr/local> --out <fresh-directory> [--cache <prepared-directory>] [--inventory <current-inventory.json>] [--eastasianwidth-replacement <verified-candidate-directory>]");
  }
  options[args[i]] = args[i + 1];
}
if (!options["--root"] || !options["--out"]) throw new Error("--root and --out are required");
const root = await realpath(options["--root"]);
const out = resolve(options["--out"]);
await mkdir(dirname(out), { recursive: true });
const parent = await realpath(dirname(out));
const output = resolve(parent, basename(out));
if ([relative(root, output), relative(output, root)].some(p => p === "" || (!p.startsWith(`..${sep}`) && p !== ".."))) {
  throw new Error("Input and output must not overlap");
}
await mkdir(output);
await mkdir(resolve(output, "notices"));
await mkdir(resolve(output, "sources"));
const recipe = JSON.parse(await readFile(fileURLToPath(new URL("../distribution/cli/components.json", import.meta.url)), "utf8"));
const grantBytes = await readFile(fileURLToPath(new URL("../distribution/cli/grants.json", import.meta.url)));
const grants = JSON.parse(grantBytes);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const cache = options["--cache"] ? await realpath(options["--cache"]) : null;
const cachedManifest = cache ? JSON.parse(await readFile(resolve(cache, "manifest.json"), "utf8")) : null;
if (cachedManifest) {
  for (const receipt of [...cachedManifest.notices, ...cachedManifest.sources]) {
    const path = await realpath(resolve(cache, receipt.destination));
    if (!path.startsWith(`${cache}${sep}`)) throw new Error(`External cache link: ${path}`);
    const bytes = await readFile(path);
    if (hash(bytes) !== receipt.sha256 || bytes.length !== receipt.bytes) {
      throw new Error(`Cache hash mismatch: ${receipt.destination}`);
    }
  }
}
const manifest = {
  schemaVersion: 1, releaseProvenance: false, platform: "linux/arm64",
  sourceRoot: root, notices: [], sources: [], native: [], warnings: [], blockers: [],
  bundledSources: recipe.bundledSources,
};
const retained = new Map();
const cachePath = path => path.replace(/^(install\/cache\/(?:@[^/]+\/)?[^/]+)\/(\d[^/]+@@@[^/]+)(?=\/|$)/, "$1@$2");
async function retain(path, expected) {
  path = cachePath(path);
  if (retained.has(path)) return retained.get(path);
  const bytes = await readFile(resolve(root, path));
  const sha256 = hash(bytes);
  if (expected && sha256 !== expected) throw new Error(`Shipped text changed: ${path}`);
  const destination = `notices/${hash(path)}-${basename(path)}`;
  await writeFile(resolve(output, destination), bytes, { flag: "wx" });
  const receipt = { shippedPath: path, destination, bytes: bytes.length, sha256 };
  retained.set(path, receipt);
  manifest.notices.push(receipt);
  return receipt;
}
// Include the seven voice files regardless of the collector filename pattern.
for (const text of recipe.voiceTexts) await retain(text.path, text.sha256);
const visited = new Set();
async function walk(path) {
  const canonical = await realpath(path);
  if (visited.has(canonical)) return;
  visited.add(canonical);
  if (!canonical.startsWith(`${root}${sep}`) && canonical !== root) throw new Error(`External input link: ${path}`);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile() && /^(?:licen[sc]e|copying|notice|ofl)(?:$|[._-])/i.test(entry.name)) await retain(relative(root, file));
  }
}
await walk(root);
for (const item of recipe.native) {
  const bytes = await readFile(resolve(root, item.path));
  if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error(`Native payload changed: ${item.path}`);
  manifest.native.push({ ...item, verified: true });
}
for (const entry of recipe.warnings) {
  if (entry.metadataSHA256) {
    const bytes = await readFile(resolve(root, cachePath(entry.warning.path), "package.json"));
    if (hash(bytes) !== entry.metadataSHA256) throw new Error(`Metadata changed: ${entry.warning.path}`);
  }
  const notices = [];
  for (const text of entry.retainedEvidence) notices.push(await retain(text.source, text.sha256));
  manifest.warnings.push({ ...entry, notices });
}
for (const path of [
  "install/global/node_modules/@google/gemini-cli/bundle/examples/mcp-server/example.js",
  "install/global/node_modules/nan/tools/1to2.js",
  "install/global/node_modules/nan/LICENSE.md",
  "install/global/node_modules/@lydell/node-pty/LICENSE",
  "install/global/node_modules/@github/keytar/LICENSE.md",
]) await retain(path);
let archiveName;
let archiveFiles;
async function tar(archive, ...args) {
  if (archiveName !== archive) {
    let bytes = await readFile(resolve(output, archive));
    if (bytes.subarray(0, 6).toString("hex") === "fd377a585a00") {
      const child = Bun.spawn(["xz", "-dc", resolve(output, archive)], { stdout: "pipe", stderr: "pipe" });
      const [data, error, code] = await Promise.all([
        new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited,
      ]);
      if (code !== 0) throw new Error(`Archive inspection failed: ${error}`);
      bytes = Buffer.from(data);
    }
    archiveFiles = await new Bun.Archive(bytes).files();
    archiveName = archive;
  }
  if (args[0] === "-t") return Buffer.from([...archiveFiles.keys()].join("\n"));
  const member = archiveFiles.get(args.at(-1));
  if (!member) throw new Error(`Missing archive member: ${args.at(-1)}`);
  return Buffer.from(await member.arrayBuffer());
}
async function download(source, group = "sources") {
  const cached = cachedManifest?.[group].find(r => r.name === source.name && r.version === source.version && r.url === source.url);
  if (cached) {
    if (source.sha256 && cached.sha256 !== source.sha256) throw new Error(`Cache identity mismatch: ${source.name}`);
    const bytes = await readFile(resolve(cache, cached.destination));
    if (source.integrity) {
      const [algorithm, expected] = source.integrity.split("-");
      if (createHash(algorithm).update(bytes).digest("base64") !== expected) throw new Error(`Cache integrity mismatch: ${source.name}`);
    }
    await link(resolve(cache, cached.destination), resolve(output, cached.destination));
    const receipt = { ...source, fetchedURL: cached.fetchedURL, destination: cached.destination, bytes: bytes.length, sha256: hash(bytes), cacheHit: true, cacheRoot: cache };
    manifest[group].push(receipt);
    return receipt;
  }
  const attempts = [];
  // The alternate endpoint addresses archive access failures, never substitutes a version.
  const urls = [source.url];
  if (source.url.startsWith("https://codeload.github.com/")) {
    const match = source.url.match(/^https:\/\/codeload.github.com\/([^/]+\/[^/]+)\/tar.gz\/(.+)$/);
    if (match) urls.push(`https://github.com/${match[1]}/archive/${match[2]}.tar.gz`);
  } else if (source.url.includes("github.com/") && source.url.includes("/archive/refs/tags/")) {
    urls.push(source.url.replace("github.com/", "codeload.github.com/").replace("/archive/refs/tags/", "/tar.gz/refs/tags/").replace(/\.tar\.gz$/, ""));
  }
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const sha256 = hash(bytes);
      if (source.sha256 && source.sha256 !== sha256) throw new Error(`SHA256 mismatch: ${sha256}`);
      if (source.integrity) {
        const [algorithm, expected] = source.integrity.split("-");
        if (createHash(algorithm).update(bytes).digest("base64") !== expected) throw new Error(`Integrity mismatch: ${source.name}`);
      }
      const destination = `${group}/${sha256}-${basename(new URL(url).pathname)}`;
      await writeFile(resolve(output, destination), bytes, { flag: "wx" });
      const receipt = { ...source, fetchedURL: url, destination, bytes: bytes.length, sha256, attempts };
      manifest[group].push(receipt);
      console.log(JSON.stringify({ component: source.name, bytes: bytes.length, sha256 }));
      return receipt;
    } catch (error) {
      attempts.push({ url, error: error.message });
    }
  }
  manifest.blockers.push({ component: source.name, version: source.version, relation: source.relation, attempts });
}
await download({
  name: "Codex LICENSE", version: "0.158.0",
  url: "https://raw.githubusercontent.com/openai/codex/rust-v0.158.0/LICENSE",
  sha256: "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
  relation: "Codex wrapper and native OpenAI components; not a grant for their dependencies",
}, "notices");
for (const source of [...recipe.sources, ...(recipe.supplementalSources ?? [])]) {
  const receipt = await download(source);
  if (!receipt) continue;
  const paths = (await tar(receipt.destination, "-t")).toString().split("\n");
  receipt.members = paths.filter(p => p && !p.endsWith("/"));
  for (const path of receipt.members.filter(p => /(?:^|\/)(?:licen[sc]e|copying|notice|authors|copyright)(?:$|[._-])/i.test(p) ||
    ((["imurmurhash", "spdx-exceptions", "spdx-license-ids", "@npmcli/agent", "eastasianwidth", "err-code"].includes(source.name) || source.name.endsWith("-published")) && /\/(?:README(?:\.md)?|package\.json)$/i.test(p)) ||
    (source.name === "err-code-published" && p === "package/bower.json"))) {
    const bytes = await tar(receipt.destination, "-xO", "--", path);
    const destination = `notices/${hash(source.name + path)}-${basename(path)}`;
    await writeFile(resolve(output, destination), bytes, { flag: "wx" });
    manifest.notices.push({ component: source.name, version: source.version, sourceArchive: receipt.destination, member: path, destination, bytes: bytes.length, sha256: hash(bytes) });
  }
  if (source.name === "keytar") {
    for (const native of manifest.native.filter(n => n.path.includes("/@github/keytar"))) {
      const member = `package/prebuilds/${native.path.split("/prebuilds/")[1]}`;
      const bytes = await tar(receipt.destination, "-xO", "--", member);
      if (hash(bytes) !== native.sha256) throw new Error(`Published prebuild mismatch: ${native.path}`);
      native.publishedSource = { archive: receipt.destination, member, sha256: hash(bytes) };
    }
  }
  if (source.name === "codex-amd64-payload") {
    const member = receipt.members.find(p => p.endsWith("/voice/manifest.json"));
    const platformManifest = JSON.parse((await tar(receipt.destination, "-xO", "--", member)).toString());
    manifest.platformProvenance = {
      package: source.name, version: source.version, archive: receipt.destination,
      manifest: platformManifest, relation: "Independent amd64 published payload; not a current image attestation",
    };
    const prefix = member.replace(/codex-resources\/voice\/manifest\.json$/, "");
    for (const [path, sha256] of Object.entries(platformManifest.sha256)) {
      const bytes = await tar(receipt.destination, "-xO", "--", prefix + path);
      if (hash(bytes) !== sha256) throw new Error(`amd64 payload manifest mismatch: ${path}`);
    }
  }
}
await download({
  name: "CC-BY-3.0", version: "3.0",
  url: "https://creativecommons.org/licenses/by/3.0/legalcode.txt",
  sha256: "e6bc9e9c474700b708f568bac9e5a8a9bcb2b1dad53442f5ba449fcb848b8e76",
  relation: "spdx-exceptions 2.5.0; The Linux Foundation, Kyle E. Mitchell; original source archive and README retained; no local changes to the data",
}, "notices");
await download({
  name: "CC0-1.0", version: "1.0",
  url: "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt",
  sha256: "a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499",
  relation: "spdx-license-ids 3.0.23 README expressly associates CC0 with this data; original author metadata retained",
}, "notices");
const terms = await readFile(fileURLToPath(new URL("../distribution/cli/LINKED-LIBRARIES.txt", import.meta.url)));
const termsDestination = "notices/LINKED-LIBRARIES.txt";
await writeFile(resolve(output, termsDestination), terms, { flag: "wx" });
manifest.notices.push({ component: "Aro linked-host terms", destination: termsDestination, bytes: terms.length, sha256: hash(terms) });
// A source receipt never proves prebuild linkage or a linked-host replacement mechanism.
manifest.blockers.push(
  { component: "native dependency closure", reason: "Exact original compiled closure remains unresolved. Recipe pins libcap 2.75 but permits libcap.a cache reuse and bwrap source override; Rust release builds without --locked. Source locks and successful jobs do not identify incorporated objects. Preserve original bwrap/Rust/V8/ICU linkage and relink obligations." },
  { component: "keytar prebuilds", reason: "All 26 cache/global prebuilds match exact published bytes. Exact tag lock pins node-addon-api 8.3.0 as a source candidate, not proof of incorporated headers. Release artifact/run correspondence and native link closure remain unresolved for all 13 labels. Directory names do not establish architecture." },
);
for (const terms of grants.terms) await download(terms, "notices");
for (const input of grants.sourceInputs) await download(input);
if (options["--eastasianwidth-replacement"]) {
  const replacementRoot = await realpath(options["--eastasianwidth-replacement"]);
  const recipeBytes = await readFile(fileURLToPath(new URL("../distribution/cli/eastasianwidth-replacement.json", import.meta.url)));
  const replacementRecipe = JSON.parse(recipeBytes);
  const files = {};
  const inputs = [];
  for (const file of replacementRecipe.files) {
    const path = await realpath(resolve(replacementRoot, file.path));
    if (!path.startsWith(`${replacementRoot}${sep}`)) throw new Error(`External replacement link: ${file.path}`);
    const bytes = await readFile(path);
    if (hash(bytes) !== file.sha256) throw new Error(`Replacement hash mismatch: ${file.path}`);
    inputs.push({ ...file, bytes: bytes.length });
    files[file.path] = bytes;
  }
  const generator = files["generate.mjs"].toString();
  const { from, to } = replacementRecipe.generatorAdaptation;
  if (generator.split(from).length !== 2) throw new Error("Replacement generator adaptation input changed");
  files["generate.mjs"] = Buffer.from(generator.replace(from, to));
  files["package.json"] = Buffer.from(`${JSON.stringify(replacementRecipe.package, null, 2)}\n`);
  files["REBUILD.md"] = await readFile(fileURLToPath(new URL("../distribution/cli/eastasianwidth-REBUILD.md", import.meta.url)));
  files["REPLACEMENT.json"] = recipeBytes;
  const archiveBytes = await new Bun.Archive(files, { compress: "gzip" }).bytes();
  const destination = `sources/${hash(archiveBytes)}-irang-eastasianwidth-compat.tar.gz`;
  await writeFile(resolve(output, destination), archiveBytes, { flag: "wx" });
  const members = Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
  manifest.sources.push({ name: replacementRecipe.package.name, version: replacementRecipe.package.version, destination, sha256: hash(archiveBytes), bytes: archiveBytes.length, members: members.map(m => m.path), delivery: "replacement-preferred-source-input" });
  manifest.replacement = { ...replacementRecipe, inputs, members, sourceArchive: destination, generatorOutputSHA256: hash(files["generate.mjs"]), integrationApplied: false };
  for (const path of ["licenses/Unicode.txt", "licenses/Project-MIT.txt", "REBUILD.md", "REPLACEMENT.json"]) {
    const bytes = files[path];
    const noticeDestination = `notices/replacement-${basename(path)}`;
    await writeFile(resolve(output, noticeDestination), bytes, { flag: "wx" });
    manifest.notices.push({ component: replacementRecipe.package.name, destination: noticeDestination, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const source of manifest.sources) {
    if (["eastasianwidth", "eastasianwidth-published", "npm"].includes(source.name) || source.members?.some(p => /(?:^|\/)eastasianwidth\//.test(p))) {
      source.delivery = "private-original-evidence-only";
    }
  }
  manifest.sourceDelivery = { ready: false, forbiddenOriginalArchives: manifest.sources.filter(s => s.delivery === "private-original-evidence-only").map(s => s.destination), externalOriginalArchives: ["Node22 source archive: deps/npm/node_modules/eastasianwidth"], requirements: replacementRecipe.integrationQueue };
  manifest.blockers.push(...replacementRecipe.integrationQueue.map(q => ({ component: q.id, reason: q.action, acceptance: q.pass })));
}
manifest.materialDispositions = [];
for (const grant of grants.packages) {
  const source = manifest.sources.find(s => s.name === `${grant.name}-published` && s.version === grant.version);
  if (!source || source.sha256 !== grant.archiveSHA256) throw new Error(`Grant archive identity mismatch: ${grant.name}`);
  const metadata = await tar(source.destination, "-xO", "--", "package/package.json");
  const readme = await tar(source.destination, "-xO", "--", "package/README.md");
  if (hash(metadata) !== grant.metadataSHA256 || hash(readme) !== grant.readmeSHA256) throw new Error(`Grant source changed: ${grant.name}`);
  const declared = JSON.parse(metadata);
  if (declared.name !== grant.name || declared.version !== grant.version || declared.license !== grant.license || declared.author !== grant.author) throw new Error(`Grant declaration mismatch: ${grant.name}`);
  manifest.materialDispositions.push({ ...grant, sourceArchive: source.destination });
  if (grant.remainingBlock && !(manifest.replacement && grant.name === "eastasianwidth")) manifest.blockers.push({ component: grant.name, version: grant.version, reason: grant.remainingBlock });
}
await writeFile(resolve(output, "notices/EXACT-PUBLISHER-GRANTS.json"), grantBytes, { flag: "wx" });
manifest.notices.push({ component: "Exact publisher grants and supplemental term labels", destination: "notices/EXACT-PUBLISHER-GRANTS.json", bytes: grantBytes.length, sha256: hash(grantBytes) });
for (const warning of manifest.warnings) {
  warning.preparationStatus = grants.packages.find(g => g.index === warning.index)?.status ?? "notice-or-identity-prepared";
  if (manifest.replacement && warning.index === manifest.replacement.original.observationIndex) warning.preparationStatus = "replacement-input-validated-not-integrated";
  const name = warning.warning.name ?? warning.owner?.name;
  const sourceName = { "@openai/codex": "codex", "mcp-server-example": "gemini-cli", "1to2": "nan" }[name] ?? name;
  warning.sourceArtifacts = manifest.sources.filter(s => s.name === sourceName).map(s => s.destination);
}
manifest.integrationRequirements = [
  "Provide equivalent release access to sources and complete build inputs; index these notices in both image notice trees.",
  "Verify modified compatible-library execution in the final linked host. Local loader replacement-path proof is not a rebuilt-library or provider invocation test.",
  "Preserve linked-host reverse-engineering permissions in LINKED-LIBRARIES.txt.",
];
manifest.summary = {
  originalCLIWarnings: manifest.warnings.length,
  originalTotalWarnings: 437,
  nativePaths: manifest.native.length,
  nativeHashes: new Set(manifest.native.map(n => n.sha256)).size,
  noticeFiles: manifest.notices.length,
  sourceArchives: manifest.sources.length,
  blockers: manifest.blockers.length,
};
if (options["--inventory"]) {
  const inventory = JSON.parse(await readFile(options["--inventory"], "utf8"));
  if (JSON.stringify(inventory.unresolved) !== JSON.stringify(manifest.warnings.map(w => w.warning))) throw new Error("Original inventory warnings changed");
  manifest.inventory = { path: resolve(options["--inventory"]), sha256: hash(await readFile(options["--inventory"])) };
}
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(manifest.summary));
if (manifest.blockers.length) process.exitCode = 1;
