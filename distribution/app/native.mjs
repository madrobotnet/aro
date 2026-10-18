import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve, posix } from "node:path";
import { createHash } from "node:crypto";
import { fetchRetry } from "../release/fetch-retry.mjs";

const revision = "ebb95f8add54eee8bed840e3fb587e4cbec857d7";
const digest = text => createHash("sha256").update(text).digest("hex");

async function noticeBytes(archive, path) {
  const listing = await Bun.$`tar -tvf ${archive}`.text();
  const links = new Map();
  for (const line of listing.split("\n")) {
    const symbolic = line.split(" -> ");
    const hard = line.split(" link to ");
    if (symbolic.length === 2) {
      const name = symbolic[0].split(/\s+/).at(-1);
      links.set(name, posix.normalize(posix.join(posix.dirname(name), symbolic[1])));
    } else if (hard.length === 2) links.set(hard[0].split(/\s+/).at(-1), hard[1]);
  }
  const seen = new Set();
  while (links.has(path)) {
    if (seen.has(path)) throw new Error("Notice symlink cycle");
    seen.add(path);
    path = links.get(path);
    if (path.startsWith("../") || posix.isAbsolute(path)) throw new Error("Notice link escapes archive");
  }
  const bytes = Buffer.from(await Bun.$`tar -xOf ${archive} ${path}`.arrayBuffer());
  if (!bytes.length) throw new Error(`Empty native notice ${path}`);
  return bytes;
}

export async function prepareNative({ root, out, save, download, architecture }) {
  if (!["amd64", "arm64"].includes(architecture)) throw new Error("Unsupported target architecture");
  const blockers = [];
  const distributions = [];
  const recipes = await download(`https://codeload.github.com/lovell/sharp-libvips/tar.gz/${revision}`,
    "sources/native/build-recipes.tar.gz", { component: "sharp-libvips@1.3.4", revision,
      relation: "Complete upstream build scripts, platform toolchains, patch application and inline modifications" });
  const prefix = `sharp-libvips-${revision}`;
  const recipe = await Bun.$`tar -xOf ${resolve(out, recipes.path)} ${prefix + "/build/posix.sh"}`.text();
  const properties = await Bun.$`tar -xOf ${resolve(out, recipes.path)} ${prefix + "/versions.properties"}`.text();
  const versions = Object.fromEntries(properties.trim().split("\n").map(line => line.split("=")));
  for (const platform of ["linux-arm64", "linuxmusl-arm64", "linux-x64", "linuxmusl-x64"]) {
    try { await access(resolve(root, `@img/sharp-libvips-${platform}/lib/libvips-cpp.so.8.18.7`)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const component = `@img/sharp-libvips-${platform}@1.3.4`;
    const metadata = await download(`https://registry.npmjs.org/@img/sharp-libvips-${platform}/1.3.4`,
      `sources/native/${platform}-registry.json`, { component, relation: "Exact platform distribution identity; x64 is not an arm64 binary" });
    const registry = JSON.parse(await readFile(resolve(out, metadata.path)));
    if (registry.version !== "1.3.4" || registry.gitHead !== revision) throw new Error(`Unexpected native distribution ${component}`);
    const receipt = await download(`https://unpkg.com/@img/sharp-libvips-${platform}@1.3.4/versions.json`,
      `notices/native/${platform}-versions.json`, { component, relation: "Actual same-version platform component manifest" });
    const componentVersions = JSON.parse(await readFile(resolve(out, receipt.path)));
    for (const [name, version] of Object.entries(componentVersions)) {
      if (versions[`VERSION_${name.toUpperCase().replaceAll("-", "_")}`] !== version) throw new Error(`Build recipe version mismatch ${name}`);
    }
    let actual = null;
    let installed = true;
    try { await access(resolve(root, `@img/sharp-libvips-${platform}/lib/libvips-cpp.so.8.18.7`)); }
    catch (error) { if (error.code !== "ENOENT") throw error; installed = false; }
    if (installed) {
      // Next standalone traces the library but can omit versions.json. The
      // published archive comparison below still establishes exact identity.
      try {
        const local = await readFile(resolve(root, `@img/sharp-libvips-${platform}/versions.json`));
        if (JSON.stringify(JSON.parse(local)) !== JSON.stringify(componentVersions)) throw new Error("Installed native manifest changed");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const bytes = await readFile(resolve(root, `@img/sharp-libvips-${platform}/lib/libvips-cpp.so.8.18.7`));
      const archiveBytes = await fetchRetry(registry.dist.tarball, () => ({ signal: AbortSignal.timeout(120000) }), {
        consume: async response => {
          if (!response.ok) throw new Error(`Published libvips archive HTTP ${response.status}`);
          const archiveBytes = Buffer.from(await response.arrayBuffer());
          const [algorithm, expected] = registry.dist.integrity.split("-");
          if (createHash(algorithm).update(archiveBytes).digest("base64") !== expected) throw new Error("Published libvips archive integrity mismatch");
          return archiveBytes;
        },
      });
      const archive = resolve(out, `.published-${platform}.tgz`);
      await writeFile(archive, archiveBytes, { flag: "wx" });
      try {
        const published = Buffer.from(await Bun.$`tar -xOf ${archive} package/lib/libvips-cpp.so.8.18.7`.arrayBuffer());
        if (!published.equals(bytes)) throw new Error(`Delivered libvips differs from published ${platform} payload`);
      } finally { await rm(archive); }
      const machine = bytes.readUInt16LE(18);
      if (bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[5] !== 1 ||
          machine !== (platform.endsWith("arm64") ? 183 : 62)) throw new Error(`Native ELF identity mismatch: ${platform}`);
      actual = { bytes: bytes.length, sha256: digest(bytes), machine,
        shippedPath: `app/node_modules/@img/sharp-libvips-${platform}/lib/libvips-cpp.so.8.18.7` };
    }
    distributions.push({ component, gitHead: registry.gitHead, dist: registry.dist, versions: componentVersions, actual,
      relation: actual ? "Installed platform library; must also match shipped image hashes" : "Pinned platform distribution only; actual platform image comparison still required" });
  }
  if (!distributions.length) throw new Error("No delivered libvips distribution found");
  const sourceMatches = [...recipe.matchAll(/\$CURL (https:\/\/.*?) \|/g)];
  const urls = sourceMatches.map(match => match[1]
    .replace(/\$\(without_(patch|prerelease) \$([A-Z_0-9]+)\)/g,
      (_, operation, key) => operation === "patch" ? versions[key].split(".").slice(0, -1).join(".") : versions[key])
    .replace(/\$\{([A-Z_0-9]+)\/\/\.\/([-_])\}/g, (_, key, separator) => versions[key].replaceAll(".", separator))
    .replace(/\$\{([A-Z_0-9]+)\}/g, (_, key) => versions[key]));
  const inputs = [];
  for (const [index, url] of urls.entries()) {
    const preceding = recipe.slice(0, sourceMatches[index].index);
    const directories = [...preceding.matchAll(/mkdir \$\{DEPS\}\/([\w-]+)/g)];
    const directory = directories.at(-1)[1];
    const componentName = directory === "jpeg" ? "mozjpeg" : directory;
    const componentVersion = versions[`VERSION_${componentName.toUpperCase().replaceAll("-", "_")}`];
    const name = `sources/native/${digest(url)}-${basename(new URL(url).pathname)}`;
    const identity = { component: `${componentName}@${componentVersion}`, nativeDistribution: "sharp-libvips@1.3.4",
      relation: "Exact source/patch URL used by pinned posix build recipe", recipeUrl: url };
    try {
      let receipt;
      try { receipt = await download(url, name, identity); }
      catch (error) {
        const archive = url.match(/^https:\/\/github.com\/([^/]+\/[^/]+)\/archive\/(.+)\.tar\.gz$/);
        const release = url.match(/^https:\/\/github.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\//);
        const alternate = archive ?? release;
        if (!alternate) throw error;
        const alternateUrl = `https://codeload.github.com/${alternate[1]}/tar.gz/${alternate[2]}`;
        receipt = await download(alternateUrl, name, { ...identity, originalFailure: error.message,
          relation: archive ? "Alternate access to same repository archive" : "Same-tag source archive; generated release inputs require comparison" });
        if (release) blockers.push({ component: url, error: "Release archive unavailable; same-tag source retained, but generated release/build-input equivalence remains unverified", alternateUrl });
      }
      inputs.push(receipt);
      if (url.endsWith(".patch")) continue;
      const listing = await Bun.$`tar -tf ${resolve(out, receipt.path)}`.text();
      const notices = listing.split("\n").filter(p => /(?:^|\/)(?:licen[sc]e|copying|notice|authors|copyright)(?:[._-]|$)/i.test(p) && !p.endsWith("/"));
      for (const notice of notices) {
        const bytes = Buffer.from(await Bun.$`tar -xOf ${resolve(out, receipt.path)} ${notice}`.arrayBuffer());
        await save(`notices/native/${digest(url + notice)}-${basename(notice)}`, bytes, { ...identity, sourceArchive: receipt.path, archivePath: notice });
      }
      // Complete preferred source preserves in-file grants even without a named notice.
    } catch (error) { blockers.push({ component: url, error: error.message }); }
  }
  // The recipe downloads notices from moving main: preserve that fact, do not
  // mistake current text for proof of the original binary's transitive content.
  try {
    await download(`https://raw.githubusercontent.com/lovell/sharp-libvips/${revision}/THIRD-PARTY-NOTICES.md`,
      "notices/native/THIRD-PARTY-NOTICES.md", { component: "sharp-libvips@1.3.4", revision, relation: "Pinned upstream transitive notices" });
  } catch (error) { blockers.push({ component: "sharp-libvips transitive notices", error: error.message }); }
  let rustSourceClosure = null;
  try {
    const rsvg = inputs.find(input => input.component === `rsvg@${versions.VERSION_RSVG}` && !input.path.endsWith(".patch"));
    const lockPath = `librsvg-${versions.VERSION_RSVG}/Cargo.lock`;
    const lockText = await Bun.$`tar -xOf ${resolve(out, rsvg.path)} ${lockPath}`.text();
    const lock = Bun.TOML.parse(lockText);
    const originalLock = await save("sources/native/rsvg-Cargo.lock", Buffer.from(lockText), {
      component: `librsvg@${versions.VERSION_RSVG}`, sourceArchive: rsvg.path, archivePath: lockPath,
      relation: "Unmodified original lock; conservative source superset, not a fabricated post-build lock",
    });
    const crates = [];
    const preferred = resolve(out, "sources/native/.preferred-librsvg");
    await mkdir(preferred);
    let patchedSource;
    try {
      await Bun.$`tar -xf ${resolve(out, rsvg.path)} -C ${preferred} --strip-components=1`.quiet();
      for (const path of ["rsvg/Cargo.toml", "librsvg-c/Cargo.toml", "meson.build"]) {
        const original = await readFile(resolve(preferred, path), "utf8");
        const modified = original.split("\n").map(line => {
          if (line.includes("image = ")) line = line.replace(', "gif", "webp"', "");
          if (line.includes("cairo-rs = ")) line = line.replace(', "pdf", "ps"', "");
          if (line.startsWith("if host_system in ['windows'")) line = line.replace(", 'linux'", "");
          return line;
        }).join("\n");
        await writeFile(resolve(preferred, path), modified);
      }
      const patch = inputs.find(input => input.recipeUrl.includes("9106011db93d701728ac2c9da50c9ab2c1bb5dc6.patch"));
      if (!patch) throw new Error("Exact librsvg patch missing");
      await Bun.$`patch --batch --fuzz=0 -p1 -d ${preferred} -i ${resolve(out, patch.path)}`.quiet();
      if (digest(await readFile(resolve(preferred, "Cargo.lock"))) !== originalLock.sha256) throw new Error("Patched preferred-source lock changed");
      patchedSource = await save("sources/native/librsvg-patched-preferred-source.tar.gz",
        Buffer.from(await Bun.$`tar -czf - -C ${preferred} .`.arrayBuffer()),
        { component: `librsvg@${versions.VERSION_RSVG}`, sourceArchive: rsvg.path,
          patch: patch.path, originalLockSha256: originalLock.sha256,
          relation: "Exact recipe feature/meson edits and retained patch; no Cargo update or compiler run; original lock preserved as conservative superset" });
    } finally {
      await rm(preferred, { recursive: true });
    }
    // This pinned recipe removes features, not dependencies. Cargo --workspace
    // preserves non-workspace packages already in the lockfile. Keep every
    // original registry source, including any later-unused packages.
    for (const pkg of lock.package.filter(pkg => pkg.source)) {
      if (pkg.source !== "registry+https://github.com/rust-lang/crates.io-index") throw new Error(`Unsupported original Rust source ${pkg.source}`);
      const url = `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`;
      const identity = { component: `${pkg.name}@${pkg.version}`, lockSha256: originalLock.sha256,
        relation: "Exact checksum-pinned source in original librsvg lock; complete conservative registry closure" };
      const receipt = await download(url, `sources/native/rust/${pkg.name}-${pkg.version}.crate`, identity);
      if (receipt.sha256 !== pkg.checksum) throw new Error(`Rust source checksum mismatch ${pkg.name}@${pkg.version}`);
      crates.push(receipt);
      const listing = await Bun.$`tar -tf ${resolve(out, receipt.path)}`.text();
      for (const notice of listing.split("\n").filter(path => /(?:^|\/)(?:licen[sc]e[^/]*|copying[^/]*|notice|authors|copyright)(?:[._-]|$)/i.test(path) && !path.endsWith("/"))) {
        const bytes = await noticeBytes(resolve(out, receipt.path), notice);
        await save(`notices/native/rust/${digest(url + notice)}-${basename(notice)}`, bytes, {
          ...identity, sourceArchive: receipt.path, archivePath: notice,
        });
      }
    }
    rustSourceClosure = { originalLock, crates, patchedSource,
      cargoCommandReference: "https://doc.rust-lang.org/cargo/commands/cargo-update.html",
      recipeChanges: "Only image gif/webp and cairo-rs pdf/ps feature removal before --workspace",
      sourceSuperset: {
        conclusion: "registry(after) subset-of registry(original) for conforming execution of exact retained recipe inputs",
        reference: "Cargo 344c4567c634a25837e3c3476aac08af84cf9203",
        conditions: "No changed requirements, source overrides, Cargo configuration or dependency-changing patch; workspace identities unchanged; subsequent cbuild --locked.",
        boundary: "Does not establish original binary/recipe correspondence, floating historical toolchain, native/sysroot closure, recipient replacement or access.",
      },
      originalPostBuildLockClaimed: false };
  } catch (error) { blockers.push({ component: "librsvg Rust transitive closure", error: error.message }); }
  return { revision, distributions, inputs, rustSourceClosure, blockers };
}
