import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, stat, link } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceWidth, archiveTree, assertNoOriginalWidth } from "./prepare-release-materials.mjs";

// Preparation, not publication. Measured native Linux inputs; never infer
// third-party permission from the application's license or missing directories.
const support = fileURLToPath(new URL("../distribution/runtime/", import.meta.url));
const lock = JSON.parse(await readFile(resolve(support, "inputs.lock.json"), "utf8"));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--image", "--runtime-root", "--out", "--cache", "--webkit-git", "--architecture"].includes(key) ||
      !process.argv[i + 1] || process.argv[i + 1].startsWith("--") || options[key]) {
    throw new Error("Usage: bun scripts/prepare-redistribution-runtime.mjs (--image IMAGE | --runtime-root ROOT) --out NEW_DIRECTORY [--cache DIRECTORY] [--webkit-git BARE_REPOSITORY]");
  }
  options[key] = process.argv[i + 1];
}
if (!options["--out"] || Boolean(options["--image"]) === Boolean(options["--runtime-root"])) {
  throw new Error("Require --out and exactly one of --image or --runtime-root");
}
const out = resolve(options["--out"]);
const architecture = options["--architecture"];
if (!["amd64", "arm64"].includes(architecture)) throw new Error("Require --architecture amd64|arm64");
const cache = options["--cache"] && resolve(options["--cache"]);
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const manifest = {
  schemaVersion: 1,
  status: "preparing",
  releaseReady: false,
  scope: "Measured native Bun and Node runtime materials",
  architecture,
  runtimes: {},
  components: [],
  notices: [],
  buildInputs: [],
  blockers: [],
};
async function run(command, cwd) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exit !== 0) throw new Error(`${command.join(" ")} exited ${exit}: ${stderr}`);
  return stdout;
}
async function save(path, bytes) {
  const target = resolve(out, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  const retained = await readFile(target);
  if (!Buffer.from(bytes).equals(retained)) throw new Error(`Retained bytes differ: ${path}`);
  return { path, bytes: retained.length, sha256: hash(retained) };
}
async function fileReceipt(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(resolve(out, path))) digest.update(chunk);
  return { path, bytes: (await stat(resolve(out, path))).size, sha256: digest.digest("hex") };
}
function verify(bytes, expected, label) {
  if ((expected.bytes !== undefined && bytes.length !== expected.bytes) ||
      (expected.sha256 && hash(bytes) !== expected.sha256) ||
      (expected.integrity && `${expected.integrity.split("-")[0]}-${hash(bytes, expected.integrity.split("-")[0], "base64")}` !== expected.integrity)) {
    throw new Error(`Integrity mismatch: ${label}`);
  }
}
async function download(item) {
  const filename = `${item.id}.tar.gz`;
  const cached = cache && Bun.file(resolve(cache, filename));
  let bytes;
  if (cached && await cached.exists()) {
    bytes = Buffer.from(await cached.arrayBuffer());
  } else {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${item.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  verify(bytes, item, item.id);
  let retained;
  if (cached && await cached.exists()) {
    await mkdir(resolve(out, "sources"), { recursive: true });
    await link(resolve(cache, filename), resolve(out, "sources", filename));
    retained = await fileReceipt(`sources/${filename}`);
  } else {
    retained = await save(`sources/${filename}`, bytes);
  }
  return { ...item, ...retained, reused: Boolean(cached && await cached.exists()) };
}
const namedNotice = /^(?:licen[sc]e|copying|notice|copyright|authors|patents)(?:$|[._-])|^README\.ijg$/i;
const retainedComments = new Map();
async function collectTexts(tree, component, prefix = "", historical = false) {
  for (const entry of (await readdir(resolve(tree, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectTexts(tree, component, path, historical);
    } else if (entry.isFile()) {
      // Named notices remain whole. Source notices retain complete comment
      // blocks, including ones inside amalgamations, not entire source files.
      const named = namedNotice.test(entry.name);
      const source = /\.(?:[cm]?[jt]sx?|[ch](?:pp)?|rs|hxx|cc|m|mm)$/.test(entry.name) ||
        (historical && /\.(?:go|zig|py|txt)$/.test(entry.name));
      if (!named && !source) continue;
      const bytes = await readFile(resolve(tree, path));
      if (!bytes.length) continue;
      const origin = {
        component: component.id, version: component.version,
        sourceUrl: component.url, archivePath: path, sourceFileSha256: hash(bytes),
      };
      if (named) {
        manifest.notices.push({ ...origin, kind: "full-upstream-text", ...await save(`notices/${component.id}/${path}`, bytes) });
        continue;
      }
      const text = bytes.toString("utf8");
      const markers = [...text.matchAll(historical
        ? /copyright|\u00a9|SPDX-License-Identifier|permission is hereby granted|licensed under|source code form is subject/gi
        : /copyright|SPDX-License-Identifier|permission is hereby granted|licensed under|source code form is subject/gi)];
      if (!markers.length) continue;
      const comments = [...text.matchAll(/(?:(?:\/\*[\s\S]*?\*\/|(?:^[ \t]*\/\/[^\n]*(?:\n|$))+)\s*)+/gm)]
        .filter(block => markers.some(marker => marker.index >= block.index && marker.index < block.index + block[0].length));
      // If a notice occurs outside a recognized comment (e.g. a JS string),
      // preserve the whole file rather than risk discarding required text.
      if (!Buffer.from(text).equals(bytes) || markers.some(marker =>
        !comments.some(block => marker.index >= block.index && marker.index < block.index + block[0].length))) {
        manifest.notices.push({ ...origin, kind: "copyright-bearing-source", ...await save(`notices/${component.id}/${path}`, bytes) });
        continue;
      }
      for (const block of comments) {
        const start = Buffer.byteLength(text.slice(0, block.index));
        const end = start + Buffer.byteLength(block[0]);
        const notice = bytes.subarray(start, end);
        const target = `notices/${component.id}/comments/${hash(notice)}.txt`;
        if (!retainedComments.has(target)) retainedComments.set(target, await save(target, notice));
        manifest.notices.push({ ...origin, kind: "complete-source-comment", sourceByteRange: { start, end }, ...retainedComments.get(target) });
      }
    }
  }
}
async function unpack(component, historical = false) {
  const archive = resolve(out, component.path);
  const names = (await run(["tar", "-tzf", archive])).trimEnd().split("\n");
  if (names.some(name => name.startsWith("/") || name.split("/").includes(".."))) {
    throw new Error(`Unsafe archive member: ${component.id}`);
  }
  if (component.members && component.members !== names.length) throw new Error(`Incomplete archive: ${component.id}`);
  const tree = resolve(out, "sources", ".inspection", component.id);
  await mkdir(tree, { recursive: true });
  await run(["tar", "-xzf", archive, "--no-same-owner", "-C", tree]);
  for (const notice of component.expectedNotices ?? []) {
    verify(await readFile(resolve(tree, notice.path)), notice, `${component.id}/${notice.path}`);
  }
  component.archiveMembers = names.length;
  const replacements = await replaceWidth(tree);
  await assertNoOriginalWidth(tree);
  if (replacements.length || component.id === "node") {
    const original = { sha256: component.sha256, bytes: component.bytes };
    const preferred = `sources/${component.id}-preferred.tar.gz`;
    await archiveTree(tree, resolve(out, preferred));
    await rm(archive);
    Object.assign(component, await fileReceipt(preferred), { upstream: original, replacements });
  }
  await collectTexts(tree, component, "", historical);
  return { tree, root: resolve(tree, names[0].split("/")[0]) };
}

await mkdir(dirname(out), { recursive: true });
await mkdir(out); // Never merge stale files into a new preparation.
try {
  // A read-only, network-disabled probe never starts the application entrypoint.
  const probe = `import{createHash}from"node:crypto";import{readFileSync}from"node:fs";
const h=p=>{let b=readFileSync(p);return{bytes:b.length,sha256:createHash("sha256").update(b).digest("hex")}};
console.log(JSON.stringify({platform:process.platform,arch:process.arch,bun:{version:Bun.version+"+"+Bun.revision.slice(0,9),...h("/usr/local/bin/bun")},node:{version:Bun.spawnSync(["/usr/local/bin/node","--version"]).stdout.toString().trim(),...h("/usr/local/bin/node")},versions:process.versions,nodeLicense:readFileSync("/usr/local/LICENSE").toString("base64")}));`;
  let runtime;
  if (options["--image"]) {
    const [image] = JSON.parse(await run(["docker", "image", "inspect", options["--image"]]));
    manifest.image = { id: image.Id, digest: image.Descriptor?.digest, os: image.Os, architecture: image.Architecture, provenance: "Local inspection only; not final release provenance" };
    runtime = JSON.parse(await run(["docker", "run", "--rm", "--read-only", "--network", "none",
      "--label", "org.aro.runtime-preparation=inspection", "--label", "aro.qa.owner=aro-id-release", "--entrypoint", "/usr/local/bin/bun", image.Id, "--no-env-file", "-e", probe]));
  } else {
    const runtimeRoot = resolve(options["--runtime-root"]);
    const bun = resolve(runtimeRoot, "usr/local/bin/bun");
    const node = resolve(runtimeRoot, "usr/local/bin/node");
    for (const file of [bun, node]) {
      const bytes = await readFile(file);
      if (bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 ||
          bytes[5] !== 1 || bytes.readUInt16LE(18) !== ({ amd64: 62, arm64: 183 })[architecture]) {
        throw new Error("Runtime ELF architecture mismatch");
      }
    }
    // Bun requires the live proc filesystem. Invoke the target's actual loader
    // and libraries without a chroot; the final native container smoke remains
    // the full-filesystem execution check.
    const triplet = { amd64: "x86_64-linux-gnu", arm64: "aarch64-linux-gnu" }[architecture];
    const loader = { amd64: "ld-linux-x86-64.so.2", arm64: "ld-linux-aarch64.so.1" }[architecture];
    const probeRun = args => run(runtimeRoot === "/" ? args : [
      resolve(runtimeRoot, "usr/lib", triplet, loader),
      "--library-path", [
        resolve(runtimeRoot, "usr/lib", triplet),
        resolve(runtimeRoot, "usr/local/lib"),
      ].join(":"),
      resolve(runtimeRoot, args[0].slice(1)), ...args.slice(1),
    ]);
    runtime = {
      ...JSON.parse(await probeRun(["/usr/local/bin/bun", "--no-env-file", "-e", "console.log(JSON.stringify({platform:process.platform,arch:process.arch}))"])),
      bun: { version: (await probeRun(["/usr/local/bin/bun", "--revision"])).trim(), bytes: (await readFile(bun)).length, sha256: hash(await readFile(bun)) },
      node: { version: (await probeRun(["/usr/local/bin/node", "--version"])).trim(), bytes: (await stat(node)).size, sha256: hash(await readFile(node)) },
      versions: JSON.parse(await probeRun(["/usr/local/bin/bun", "--no-env-file", "-e", "console.log(JSON.stringify(process.versions))"])),
      nodeLicense: (await readFile(resolve(runtimeRoot, "usr/local/LICENSE"))).toString("base64"),
    };
  }
  if (runtime.platform !== "linux" || runtime.arch !== ({amd64:"x64", arm64:"arm64"})[architecture] ||
      process.arch !== runtime.arch) throw new Error("Require matching native Linux runtime architecture");
  for (const name of ["bun", "node"]) {
    if (runtime[name].version !== lock.runtimes[name].version) {
      throw new Error(`Unexpected shipped runtime bytes/version: ${name}`);
    }
  }
  if (runtime.versions.webkit !== lock.webkitCommit || runtime.versions.tinycc !== "05f0fafaa3be31e31d7b4b5c17dc60f62c991171") {
    throw new Error("Shipped WebKit/TinyCC revision differs from source lock");
  }
  const nodeLicense = Buffer.from(runtime.nodeLicense, "base64");
  verify(nodeLicense, lock.nodeLicense, "shipped Node full LICENSE");
  delete runtime.nodeLicense;
  manifest.runtimes = runtime;
  manifest.notices.push({ component: "node", version: "22.23.3", sourceUrl: "https://nodejs.org/dist/v22.23.3/node-v22.23.3.tar.gz", shippedPath: "/usr/local/LICENSE", ...await save("notices/node/LICENSE", nodeLicense) });

  let bunTree;
  for (const item of lock.archives) {
    if (item.pin) verify(await readFile(resolve(bunTree, item.pin)), { sha256: item.pinSha256 }, item.pin);
    const component = await download(item);
    const extracted = await unpack(component);
    if (item.id === "bun") {
      bunTree = extracted.root;
      const cargo = Bun.TOML.parse(await readFile(resolve(bunTree, "Cargo.lock"), "utf8"));
      for (const crate of cargo.package.filter(pkg => pkg.source?.startsWith("registry+"))) {
        const receipt = lock.archives.find(row => row.id === `crate-${crate.name}-${crate.version}`);
        if (receipt?.sha256 !== crate.checksum) throw new Error(`Missing exact Cargo input: ${crate.name}`);
      }
    } else {
      await rm(extracted.tree, { recursive: true });
    }
    manifest.components.push(component);
    console.log(`RETAINED ${component.id} ${component.sha256}`);
  }
  // These three locked graphs are consumed by the matching codegen recipes.
  // Download tarballs directly; never invoke npm or run package lifecycle code.
  const jsInputs = new Map();
  for (const directory of ["", "src/node-fallbacks", "packages/bun-error"]) {
    const path = `${directory ? `${directory}/` : ""}bun.lock`;
    const text = await readFile(resolve(bunTree, path), "utf8");
    const graph = Bun.JSONC.parse(text);
    for (const row of Object.values(graph.packages)) {
      if (row[0].includes("@workspace:")) continue;
      const split = row[0].lastIndexOf("@");
      const name = row[0].slice(0, split);
      const version = row[0].slice(split + 1);
      const integrity = row.at(-1);
      if (typeof integrity !== "string" || !/^sha(?:256|512)-/.test(integrity)) throw new Error(`Unpinned JS build input: ${row[0]}`);
      const id = `js-${name.replaceAll("/", "-").replaceAll("@", "")}-${version}`;
      if (!jsInputs.has(id)) jsInputs.set(id, {
        id, name, version, integrity,
        url: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
        relation: "Locked JavaScript codegen/polyfill build input; conservative notice retention, not a claim every package is embedded",
        pin: path,
      });
    }
  }
  for (const item of jsInputs.values()) {
    const component = await download(item);
    const extracted = await unpack(component);
    await rm(extracted.tree, { recursive: true });
    manifest.components.push(component);
    console.log(`RETAINED ${component.id} ${component.sha256}`);
  }
  for (const path of ["LICENSE.md", "docs/project/license.mdx", "docs/project/contributing.mdx", "Cargo.lock", "Cargo.toml", "rust-toolchain.toml", "package.json", "bun.lock", "src/node-fallbacks/bun.lock", "packages/bun-error/bun.lock", "scripts/build/deps/tinycc.ts", "scripts/build/deps/webkit.ts", "scripts/build/source.ts", "scripts/build/config.ts", "scripts/build/tools.ts", "scripts/build/profiles.ts", "patches/tinycc/tcc.h.patch", "scripts/glob-sources.ts", "src/css/README.md", "src/jsc/bindings/workaround-missing-symbols.cpp", "src/jsc/bindings/stringWidth.cpp", "src/jsc/bindings/stringWidthTables.h", "scripts/generate-stringwidth-tables.mjs", "src/runtime/ffi/ffi_body.rs", "src/resolver/node_fallbacks.rs"]) {
    manifest.buildInputs.push({ component: "bun", version: lock.bunCommit, archivePath: path, ...await save(`sources/build-inputs/${path}`, await readFile(resolve(bunTree, path))) });
  }
  await rm(resolve(out, "sources", ".inspection", "bun"), { recursive: true });

  // Git transport avoids GitHub's blocked codeload export for this commit.
  const repository = options["--webkit-git"] ? resolve(options["--webkit-git"]) : resolve(out, "sources", ".webkit.git");
  if (!options["--webkit-git"]) {
    await run(["git", "init", "--bare", repository]);
    await run(["git", "-C", repository, "fetch", "--depth=1", "https://github.com/oven-sh/WebKit.git", lock.webkitCommit]);
  }
  const git = (...args) => run(["git", "-C", repository, ...args]);
  if ((await git("rev-parse", "--is-bare-repository")).trim() !== "true") throw new Error("--webkit-git must be a bare repository");
  const tree = (await git("rev-parse", `${lock.webkitCommit}^{tree}`)).trim();
  if (tree !== lock.webkitTree) throw new Error("Wrong WebKit tree");
  await git("fsck", "--full", "--no-reflogs");
  const entries = (await git("ls-tree", "-rz", lock.webkitCommit)).split("\0").filter(Boolean);
  if (entries.some(line => line.includes("\n"))) throw new Error("Unsupported newline in WebKit git path");
  if (entries.some(line => line.startsWith("160000 "))) throw new Error("WebKit gitlinks require separate complete exports");
  const archive = "sources/webkit.tar.gz";
  // The repository's export-ignore rules omit .gitignore/.gitattributes.
  // An empty worktree (and no index in this bare repository) exports the
  // complete raw tree rather than applying those archive transformations.
  const attributes = resolve(out, "sources", ".empty-attributes");
  const cachedWebkit = cache && resolve(cache, "webkit.tar.gz");
  if (cachedWebkit && await Bun.file(cachedWebkit).exists()) {
    await link(cachedWebkit, resolve(out, archive));
  } else {
    await mkdir(attributes);
    await git(`--work-tree=${attributes}`, "-c", "core.attributesFile=/dev/null",
      "-c", "core.bigFileThreshold=2g", "archive", "--worktree-attributes",
      "--format=tar.gz", `--prefix=WebKit-${lock.webkitCommit}/`,
      `--output=${resolve(out, archive)}`, lock.webkitCommit);
    await rm(attributes, { recursive: true });
  }
  const webkitReceipt = await fileReceipt(archive);
  if (webkitReceipt.sha256 !== lock.webkitArchiveSha256) throw new Error("WebKit export hash differs from complete verified export");
  const archivePaths = new Set((await run(["tar", "--quoting-style=literal", "-tzf", resolve(out, archive)])).trimEnd().split("\n")
    .filter(path => !path.endsWith("/")).map(path => path.slice(path.indexOf("/") + 1)));
  const gitPaths = entries.map(line => line.slice(line.indexOf("\t") + 1));
  if (archivePaths.size !== gitPaths.length || gitPaths.some(path => !archivePaths.has(path))) {
    throw new Error("WebKit export does not contain every git tree member");
  }
  const webkit = { id: "webkit", version: lock.webkitCommit, tree, gitFiles: entries.length, url: "https://github.com/oven-sh/WebKit.git", ...webkitReceipt, relation: "Complete source tree for statically linked JavaScriptCore/WebCore/WTF/bmalloc; git fsck passed; every git path exported; no gitlinks" };
  const extracted = await unpack(webkit);
  manifest.components.push(webkit);
  await rm(extracted.tree, { recursive: true });
  if (!options["--webkit-git"]) await rm(repository, { recursive: true });
  const history = JSON.parse(await readFile(resolve(support, "history.lock.json"), "utf8"));
  for (const item of history.archives) {
    const component = { ...await download(item),
      relation: "Historical permission/notice/source superset, not an original import revision claim" };
    const historicalTree = await unpack(component, true);
    await rm(historicalTree.tree, { recursive: true });
    manifest.components.push(component);
  }
  for (const item of history.texts) {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${item.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verify(bytes, item, item.file);
    manifest.notices.push({ component: item.component, version: item.version,
      sourceUrl: item.url, kind: "historical-permission-material",
      ...await save(`notices/history/${item.id}.txt`, bytes) });
  }
  manifest.attributionPermissionMaterial = {
    basis: "Conservative historical grant/notice/source superset; see notices/PERMISSIONS.md",
    originalImportRevisionClaimed: false,
    sourcePublicationVerified: false,
  };
  manifest.notices.push({ component: "runtime-preparation", kind: "derived-source-permission-and-access",
    ...await save("notices/PERMISSIONS.md", await readFile(resolve(support, "PERMISSIONS.md"))) });
  await rm(resolve(out, "sources", ".inspection"), { recursive: true });
  for (const file of ["REBUILD.md"]) {
    manifest.buildInputs.push({ component: "runtime-preparation", ...await save(`sources/${file}`, await readFile(resolve(support, file))) });
  }
  manifest.notices.push({ component: "runtime-preparation", kind: "distributor-component-attribution", ...await save("notices/RUNTIME-NOTICE.md", await readFile(resolve(support, "NOTICE.md"))) });
  for (const item of JSON.parse(await readFile(resolve(support, "texts.lock.json"), "utf8"))) {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${item.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verify(bytes, item, item.url);
    manifest.notices.push({
      component: item.component, version: item.version, sourceUrl: item.url,
      relation: item.relation, kind: "full-upstream-text",
      ...await save(`notices/${item.component}/${item.file}`, bytes),
    });
  }
  // Never turn a successfully downloaded archive into a release approval.
  manifest.verificationBoundary = "Source acquisition does not establish a successful modified WebKit/TinyCC relink or original compiler identity.";
  manifest.status = "materials-prepared-relink-unverified";
  manifest.originalBuildIdentityClaimed = false;
  manifest.fullModifiedWebKitRelinkVerified = false;
  manifest.fullRuntimeRelinkVerified = false;
} catch (error) {
  manifest.status = "blocked";
  manifest.blockers.push(error.message);
  console.error(error.message);
} finally {
  await writeFile(resolve(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(`${manifest.status}: ${manifest.components.length} archives, ${manifest.notices.length} notices`);
if (manifest.status === "blocked") process.exitCode = 1;
