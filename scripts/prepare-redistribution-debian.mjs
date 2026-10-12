import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

// Exact installed-package notices and corresponding Debian source.
// Not a license approval, publication step, or generic source lookup.
//
// Usage:
//   bun scripts/prepare-redistribution-debian.mjs \
//     (--image <ref> | --root <rootfs>) \
//     --out <new-directory> \
//     [--expected-index sha256:<64-hex>] \
//     [--receipts <debian-source-receipts.json>] \
//     [--cache <prepared-source-directory>]
//
// --expected-index is required with --image. --image and --root are mutually
// exclusive. --receipts reuses matching .dsc text; --cache reuses matching
// indexed source files. Both are optional and have no default evidence path.
// Source URLs come only from the image apt configuration's source indexes, or
// from a receipt entry whose name, version, URL path, and hash match that index.
// A commented snapshot URL is not a source.

const USAGE = "Usage: bun scripts/prepare-redistribution-debian.mjs (--image <ref> | --root <rootfs>) --out <new-directory> [--expected-index sha256:<64-hex>] [--receipts <debian-source-receipts.json>] [--cache <prepared-source-directory>]";
const FLAGS = ["--image", "--root", "--out", "--expected-index", "--receipts", "--cache"];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = `
import fs from "node:fs";
import cp from "node:child_process";
import crypto from "node:crypto";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const read = (path) => {
  const bytes = fs.readFileSync(path);
  let link = null;
  try { link = fs.readlinkSync(path); } catch { /* not a symlink */ }
  return {
    path,
    bytes: bytes.length,
    sha256: hash(bytes),
    symlink: link,
    realpath: fs.realpathSync(path),
    text: bytes.toString("utf8"),
  };
};
const query = cp.spawnSync("dpkg-query", ["-W", "-f=\${binary:Package}\\t\${Package}\\t\${Version}\\t\${Architecture}\\t\${source:Package}\\t\${source:Version}\\t\${db:Status-Abbrev}\\n"], { encoding: "utf8" });
if (query.status !== 0) {
  process.stderr.write(query.stderr || "dpkg-query failed\\n");
  process.exit(1);
}
const packages = query.stdout.trim().split("\\n").filter(Boolean).map((line) => {
  const [binary, name, version, architecture, sourcePackage, sourceVersion, status] = line.split("\\t");
  const doc = "/usr/share/doc/" + name;
  let docLink = null;
  try { docLink = fs.lstatSync(doc).isSymbolicLink() ? fs.readlinkSync(doc) : null; }
  catch (error) { docLink = { error: error.code }; }
  const copyrightPath = doc + "/copyright";
  const bytes = fs.readFileSync(copyrightPath);
  return {
    binary, name, version, architecture, sourcePackage, sourceVersion, status, docLink,
    copyright: {
      path: copyrightPath,
      realpath: fs.realpathSync(copyrightPath),
      bytes: bytes.length,
      sha256: hash(bytes),
      base64: bytes.toString("base64"),
    },
  };
});
const common = fs.readdirSync("/usr/share/common-licenses").sort().map((name) => {
  const path = "/usr/share/common-licenses/" + name;
  const bytes = fs.readFileSync(path);
  return {
    name,
    symlink: fs.lstatSync(path).isSymbolicLink() ? fs.readlinkSync(path) : null,
    realpath: fs.realpathSync(path),
    bytes: bytes.length,
    sha256: hash(bytes),
    base64: bytes.toString("base64"),
  };
});
const apt = [];
for (const path of ["/etc/apt/sources.list", "/etc/os-release", "/etc/debian_version"]) {
  apt.push(fs.existsSync(path) ? read(path) : { path, error: "ENOENT" });
}
const sourceDir = "/etc/apt/sources.list.d";
const sources = fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir).sort().map((name) => read(sourceDir + "/" + name)) : [];
process.stdout.write(JSON.stringify({ packages, common, apt, sources }));
`;

class DebianSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "DebianSourceError";
  }
}

const fail = (message) => {
  throw new DebianSourceError(message);
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.includes(flag) || !value || value.startsWith("--") || options[flag]) fail(USAGE);
    options[flag] = value;
  }
  if (Boolean(options["--image"]) === Boolean(options["--root"]) || !options["--out"]) fail(USAGE);
  if (options["--image"] && !options["--expected-index"]) fail(`${USAGE}; --expected-index is required with --image`);
  if (options["--root"] && options["--expected-index"]) fail("--expected-index applies only to --image");
  if (options["--expected-index"] && !/^sha256:[0-9a-f]{64}$/i.test(options["--expected-index"])) {
    fail("--expected-index must be sha256: followed by 64 hex characters");
  }
  if (options["--image"] && /\s/.test(options["--image"])) fail("--image must be one image reference");
  return options;
};

const parseDeb822 = (text, comments) => {
  const stanzas = [];
  for (const block of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n\n")) {
    const fields = new Map();
    let key = null;
    for (const line of block.split("\n")) {
      if (line.trim() === "") continue;
      if (comments && line.startsWith("#")) continue;
      if (line.startsWith(" ") || line.startsWith("\t")) {
        if (!key) fail("deb822 continuation without a field");
        const value = line.trim();
        if (value) fields.get(key).push(value);
        continue;
      }
      const split = line.indexOf(":");
      if (split <= 0) fail(`bad deb822 line: ${line}`);
      key = line.slice(0, split);
      if (fields.has(key)) fail(`duplicate deb822 field ${key}`);
      const value = line.slice(split + 1).trim();
      fields.set(key, value ? [value] : []);
    }
    if (fields.size) stanzas.push(fields);
  }
  return stanzas;
};

const one = (stanza, name) => {
  const lines = stanza.get(name);
  if (!lines || lines.length !== 1) fail(`missing or multiline ${name}`);
  return lines[0];
};

const parseChecksums = (lines, label) => {
  if (!lines?.length) fail(`missing ${label}`);
  return lines.map((line) => {
    const match = /^([0-9a-f]{64})\s+(\d+)\s+(\S+)$/i.exec(line);
    if (!match) fail(`bad ${label} line: ${line}`);
    return { sha256: match[1].toLowerCase(), bytes: Number(match[2]), name: match[3] };
  });
};

const safeSegment = (value, label) => {
  if (!/^[A-Za-z0-9._+~-]+$/.test(value)) fail(`unsafe ${label}: ${value}`);
  return value;
};

const splitVersion = (version) => {
  const colon = version.indexOf(":");
  if (colon === -1) return { epoch: null, upstream: version };
  if (!/^[0-9]+$/.test(version.slice(0, colon))) fail(`bad epoch in ${version}`);
  return { epoch: version.slice(0, colon), upstream: version.slice(colon + 1) };
};

const clearsignBody = (text) => {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.includes("-----BEGIN PGP SIGNED MESSAGE-----")) return { body: normalized, clearsigned: false };
  const lines = normalized.split("\n");
  let index = lines.findIndex((line) => line.startsWith("-----BEGIN PGP SIGNED MESSAGE-----")) + 1;
  while (index < lines.length && lines[index].trim() !== "") index += 1;
  if (lines[index]?.trim() !== "") fail("clearsigned message has no header separator");
  index += 1;
  const body = [];
  for (; index < lines.length; index += 1) {
    if (lines[index].startsWith("-----BEGIN PGP SIGNATURE-----")) break;
    body.push(lines[index].startsWith("- ") ? lines[index].slice(2) : lines[index]);
  }
  if (index >= lines.length) fail("clearsigned message has no signature");
  return { body: body.join("\n"), clearsigned: true };
};

const run = (command, args) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", reject);
  child.on("close", (code) => {
    const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") };
    if (code !== 0) reject(new DebianSourceError(`${command} exited ${code}: ${result.stderr.trim()}`));
    else resolvePromise(result);
  });
});

const sameResource = (left, right) => {
  const a = new URL(left);
  const b = new URL(right);
  return a.host === b.host && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
};

const fetchExact = async (url, timeoutMs) => {
  let current = new URL(url);
  if (current.protocol !== "http:" && current.protocol !== "https:") fail(`unsupported URL scheme ${url}`);
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "accept-encoding": "identity", "user-agent": "aro-debian-source-prepare" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) fail(`redirect without location from ${current}`);
      const next = new URL(location, current);
      if (next.host !== current.host) fail(`refusing cross-host redirect ${current} -> ${next}`);
      if (next.pathname !== current.pathname || next.search !== current.search) fail(`refusing path-changing redirect ${current} -> ${next}`);
      if (next.protocol !== current.protocol && !(current.protocol === "http:" && next.protocol === "https:")) {
        fail(`refusing scheme change ${current} -> ${next}`);
      }
      await response.body?.cancel();
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail(`HTTP ${response.status} for ${current}`);
    }
    return { response, finalUrl: current.toString() };
  }
  fail(`too many redirects for ${url}`);
};

const downloadBytes = async (url, timeoutMs) => {
  const { response, finalUrl } = await fetchExact(url, timeoutMs);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, finalUrl, sha256: sha256(bytes) };
};

const downloadFile = async (url, dest, expected) => {
  const { response, finalUrl } = await fetchExact(url, 600_000);
  const hash = createHash("sha256");
  let size = 0;
  const stream = createWriteStream(dest);
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      size += value.byteLength;
      if (!stream.write(Buffer.from(value))) await once(stream, "drain");
    }
    stream.end();
    await finished(stream);
  } catch (error) {
    stream.destroy();
    await rm(dest, { force: true });
    throw error;
  }
  const digest = hash.digest("hex");
  if (digest !== expected.sha256 || size !== expected.bytes) {
    await rm(dest, { force: true });
    fail(`hash or size mismatch for ${url}: got ${digest} ${size}, index ${expected.sha256} ${expected.bytes}`);
  }
  return { sha256: digest, bytes: size, finalUrl, byteSource: "network" };
};

const copyCachedFile = async (cache, record, dest, expected) => {
  const cachedPath = join(cache, "sources", record, expected.name);
  let bytes;
  try {
    bytes = await readFile(cachedPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const digest = sha256(bytes);
  if (digest !== expected.sha256 || bytes.length !== expected.bytes) {
    fail(`cache hash or size mismatch for ${record}/${expected.name}: got ${digest} ${bytes.length}, index ${expected.sha256} ${expected.bytes}`);
  }
  await writeFile(dest, bytes, { flag: "wx" });
  return { sha256: digest, bytes: bytes.length, finalUrl: expected.url, byteSource: "cache" };
};

const aptEntries = (files) => {
  const entries = [];
  for (const file of files) {
    if (file.error === "ENOENT") continue;
    if (file.error) fail(`unreadable apt source ${file.path}: ${file.error}`);
    if (basename(file.path) === "sources.list" || file.path.endsWith(".list")) {
      for (const raw of file.text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const parts = line.split(/\s+/);
        if (parts[0] !== "deb" && parts[0] !== "deb-src") fail(`unsupported apt line in ${file.path}: ${line}`);
        let index = 1;
        if (parts[index]?.startsWith("[")) {
          while (index < parts.length && !parts[index].endsWith("]")) index += 1;
          index += 1;
        }
        const uri = parts[index];
        const suite = parts[index + 1];
        const components = parts.slice(index + 2);
        if (!uri || !suite || !components.length) fail(`incomplete apt line in ${file.path}: ${line}`);
        entries.push({ type: parts[0], uri: uri.replace(/\/$/, ""), suite, components, path: file.path });
      }
      continue;
    }
    for (const stanza of parseDeb822(file.text, true)) {
      const types = (stanza.get("Types") ?? []).join(" ").split(/\s+/).filter(Boolean);
      const uris = (stanza.get("URIs") ?? []).join(" ").split(/\s+/).filter(Boolean);
      const suites = (stanza.get("Suites") ?? []).join(" ").split(/\s+/).filter(Boolean);
      const components = (stanza.get("Components") ?? []).join(" ").split(/\s+/).filter(Boolean);
      if (!types.length && !uris.length && !suites.length) continue;
      if (!types.length || !uris.length || !suites.length || !components.length) fail(`incomplete apt stanza in ${file.path}`);
      for (const type of types) {
        if (type !== "deb" && type !== "deb-src") fail(`unsupported apt type ${type} in ${file.path}`);
        for (const uri of uris) for (const suite of suites) {
          entries.push({ type, uri: uri.replace(/\/$/, ""), suite, components, path: file.path });
        }
      }
    }
  }
  if (!entries.length) fail("image apt configuration has no Debian archive entries");
  return entries;
};

const decompressXz = (bytes) => new Promise((resolvePromise, reject) => {
  const child = spawn("xz", ["-dc"], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (error) => reject(error.code === "ENOENT" ? new DebianSourceError("xz is required to read a Release-listed Sources.xz index") : error));
  child.on("close", (code) => {
    if (code !== 0) reject(new DebianSourceError(`xz exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    else resolvePromise(Buffer.concat(stdout));
  });
  child.stdin.end(bytes);
});

const loadIndex = async (entry, component) => {
  const releaseUrl = `${entry.uri}/dists/${entry.suite}/Release`;
  const release = await downloadBytes(releaseUrl, 120_000);
  const releaseStanza = parseDeb822(release.bytes.toString("utf8"), false)[0];
  if (!releaseStanza) fail(`empty Release at ${releaseUrl}`);
  const sums = parseChecksums(releaseStanza.get("SHA256"), `${releaseUrl} SHA256`);
  const listed = ["Sources.xz", "Sources.gz", "Sources"]
    .map((name) => sums.find((item) => item.name === `${component}/source/${name}`))
    .filter(Boolean);
  if (!listed.length) fail(`no source index hash in ${releaseUrl} for ${component}`);
  const missing = [];
  let selected = null;
  let compressed = null;
  for (const candidate of listed) {
    const indexUrl = `${entry.uri}/dists/${entry.suite}/${candidate.name}`;
    try {
      const downloaded = await downloadBytes(indexUrl, 300_000);
      if (downloaded.sha256 !== candidate.sha256 || downloaded.bytes.length !== candidate.bytes) {
        fail(`source index hash changed at ${indexUrl}`);
      }
      selected = candidate;
      compressed = downloaded;
      break;
    } catch (error) {
      if (!(error instanceof DebianSourceError) || !error.message.startsWith("HTTP 404")) throw error;
      missing.push(indexUrl);
    }
  }
  if (!selected) fail(`Release-listed source index is not published for ${entry.suite}/${component}: ${missing.join(", ")}`);
  const indexUrl = `${entry.uri}/dists/${entry.suite}/${selected.name}`;
  const plain = selected.name.endsWith(".gz") ? gunzipSync(compressed.bytes)
    : selected.name.endsWith(".xz") ? await decompressXz(compressed.bytes)
      : compressed.bytes;
  const plainSum = sums.find((item) => item.name === `${component}/source/Sources`);
  if (plainSum && (sha256(plain) !== plainSum.sha256 || plain.length !== plainSum.bytes)) {
    fail(`decompressed source index does not match ${releaseUrl} ${component}/source/Sources`);
  }
  return {
    url: indexUrl,
    finalUrl: compressed.finalUrl,
    releaseUrl,
    archive: entry.uri,
    suite: entry.suite,
    component,
    compressedSha256: compressed.sha256,
    sha256: sha256(plain),
    bytes: plain.length,
    stanzas: parseDeb822(plain.toString("utf8"), false),
  };
};

const fileRole = (name) => {
  if (name.endsWith(".dsc")) return "source-control";
  if (name.endsWith(".asc")) return "detached-signature";
  if (name.includes(".debian.tar") || name.endsWith(".diff.gz")) return "debian-changes";
  if (name.includes(".orig.tar") || name.includes(".orig-")) return "upstream";
  return "native-source";
};

const sameFileSet = (left, right) => {
  if (left.directory !== right.directory || left.files.length !== right.files.length) return false;
  const byName = new Map(right.files.map((file) => [file.name, file]));
  return left.files.every((file) => {
    const other = byName.get(file.name);
    return other?.sha256 === file.sha256 && other.bytes === file.bytes;
  });
};

const referencedLicenses = (text, names) => {
  const found = new Set();
  const unresolved = new Set();
  for (const match of text.matchAll(/\/usr\/share\/common-licenses\/([A-Za-z0-9._+-]+)/g)) {
    let name = match[1];
    while (name && !names.has(name) && /[.,;:)]$/.test(name)) name = name.slice(0, -1);
    if (names.has(name)) found.add(name);
    else unresolved.add(match[1]);
  }
  return {
    referencedCommonLicenses: [...found].sort(),
    unresolvedCommonLicenseReferences: [...unresolved].sort(),
  };
};

const supplementalLicenseCrossReferences = (packages, commonLicenses) => {
  const gzip = packages.find((pkg) => pkg.package === "gzip" && pkg.sourceVersion === "1.12-1");
  const grant = commonLicenses.find((license) => license.name === "GFDL-1.3");
  if (!gzip || gzip.copyright.sha256 !== "1ca5dd5098fe2e1c0f0d05196f5b3da8b414a807702e6ca8b536eb5fd3059130" ||
      !grant || grant.sha256 !== "110535522396708cea37c72a802c5e7e81391139f5f7985631c93ef242b206a4") return [];
  return [{
    package: gzip.name,
    sourcePackage: gzip.sourcePackage,
    sourceVersion: gzip.sourceVersion,
    originalCopyrightPath: "/usr/share/common-licenses/GFDL-3",
    originalReferenceStatus: "unresolved",
    originalCopyrightSha256: gzip.copyright.sha256,
    statedGrant: "GFDL-1.3+-no-invariant",
    supplementalMapping: {
      path: "/usr/share/common-licenses/GFDL-1.3",
      noticePath: grant.noticePath,
      sha256: grant.sha256,
      bytes: grant.bytes,
    },
    basis: "The unchanged copyright grants GFDL-1.3+-no-invariant; the referenced GFDL-3 path is absent. This mapping identifies the retained GFDL-1.3 text and does not alter the original reference or terms.",
  }];
};

const resolveOutput = async (requested) => {
  let ancestor = dirname(requested);
  const suffix = [basename(requested)];
  for (;;) {
    try {
      return resolve(await realpath(ancestor), ...suffix);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      suffix.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) fail(`cannot resolve ${requested}`);
      ancestor = parent;
    }
  }
};

const assertOutputAllowed = (out, input) => {
  if (inside(REPO_ROOT, out) && !inside(join(REPO_ROOT, ".omo"), out)) {
    fail("--out inside the repository must be under .omo/ so source archives are not committed");
  }
  if (input && (inside(input, out) || inside(out, input))) fail("input and output trees must not overlap");
};

const imageInventory = async (image, expectedIndex) => {
  const inspected = JSON.parse((await run("docker", ["image", "inspect", "--format", "{{json .}}", image])).stdout.toString("utf8"));
  const expected = expectedIndex.toLowerCase();
  const digests = inspected.RepoDigests ?? [];
  const matchedField = inspected.Id.toLowerCase() === expected ? "Id"
    : digests.some((digest) => digest.toLowerCase().endsWith(`@${expected}`)) ? "RepoDigests" : null;
  if (!matchedField) fail(`image ${image} index is not ${expectedIndex}`);
  if (inspected.Os !== "linux") fail(`image ${image} OS is ${inspected.Os}, not linux`);
  const { Id: id, Architecture: architecture, Os: os, RepoTags: repoTags } = inspected;
  const container = `aro-debian-source-${randomBytes(4).toString("hex")}`;
  const probe = join(tmpdir(), `${container}.mjs`);
  await writeFile(probe, PROBE);
  try {
    const result = await run("docker", [
      "run", "--name", container, "--network", "none", "--pull", "never", "--user", "0",
      "--label", `org.aro.redistribution.debian=${container}`,
      "--label", "aro.qa.owner=aro-id-release",
      "--entrypoint", "/usr/local/bin/node",
      "--mount", `type=bind,src=${probe},dst=/tmp/debian-source-probe.mjs,readonly`,
      image, "/tmp/debian-source-probe.mjs",
    ]);
    if (result.stderr.trim()) fail(`inventory probe wrote stderr: ${result.stderr.trim()}`);
    return {
      inventory: JSON.parse(result.stdout.toString("utf8")),
      image: {
        reference: image,
        indexDigest: expected,
        identityField: matchedField,
        architecture,
        os,
        id,
        repoTags,
        finalReleaseProvenance: false,
      },
      container,
    };
  } finally {
    await rm(probe, { force: true });
    await run("docker", ["rm", "-f", container]).catch((error) => {
      if (!String(error.message).includes("No such container")) throw error;
    });
    const left = await run("docker", ["ps", "-aq", "--filter", `label=org.aro.redistribution.debian=${container}`]);
    if (left.stdout.toString("utf8").trim()) fail(`temporary container ${container} is still present`);
  }
};

const rootInventory = async (root) => {
  // Probe with the target loader and filesystem, including absolute symlinks.
  const command = root === "/" ? ["/usr/local/bin/node", ["--input-type=module", "-e", PROBE]]
    : ["chroot", [root, "/usr/local/bin/node", "--input-type=module", "-e", PROBE]];
  const result = await run(...command);
  return { inventory: JSON.parse(result.stdout.toString("utf8")), image: null };
};

const normalizePackages = (rows) => rows.map((row) => {
  const status = String(row.status).trim();
  if (status !== "ii") fail(`package ${row.binary} status ${JSON.stringify(row.status)} is not installed`);
  if (!row.copyright?.base64) fail(`missing copyright bytes for ${row.binary}`);
  const bytes = Buffer.from(row.copyright.base64, "base64");
  if (sha256(bytes) !== row.copyright.sha256 || bytes.length !== row.copyright.bytes) fail(`copyright hash changed for ${row.binary}`);
  if (row.docLink?.error) fail(`missing doc directory for ${row.binary}: ${row.docLink.error}`);
  return { ...row, status, copyrightBytes: bytes };
});

const loadReceipts = async (path) => {
  const bytes = await readFile(path);
  const data = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(data.sources)) fail("receipts file has no sources array");
  const map = new Map();
  for (const source of data.sources) {
    const key = `${source.name}\t${source.version}`;
    if (map.has(key)) fail(`duplicate receipt for ${source.name} ${source.version}`);
    map.set(key, source);
  }
  return { map, sha256: sha256(bytes), bytes: bytes.length };
};

const receiptAgrees = (receipt, record) => {
  if (!receipt) return null;
  if (receipt.dsc?.sha256 !== record.dsc.sha256 || receipt.dsc?.bytes !== record.dsc.bytes) {
    fail(`receipt hash changed for ${record.name} ${record.version} .dsc`);
  }
  if (!sameResource(receipt.dsc.url, record.dsc.url)) fail(`receipt URL does not match the source index for ${record.name} ${record.version}`);
  const byName = new Map((receipt.artifacts ?? []).map((file) => [file.name, file]));
  if (byName.size !== record.files.length) fail(`receipt file set changed for ${record.name} ${record.version}`);
  for (const file of record.files) {
    const artifact = byName.get(file.name);
    if (!artifact || artifact.sha256 !== file.sha256 || artifact.bytes !== file.bytes || !sameResource(artifact.url, file.url)) {
      fail(`receipt hash or URL changed for ${record.name} ${file.name}`);
    }
  }
  const text = receipt.dsc.text;
  if (typeof text === "string" && Buffer.byteLength(text) === receipt.dsc.bytes && sha256(text) === receipt.dsc.sha256) return Buffer.from(text);
  return null;
};

const pool = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
};

const prepare = async (options) => {
  const requestedOut = await resolveOutput(resolve(options["--out"]));
  const input = options["--root"] ? await realpath(resolve(options["--root"])) : null;
  assertOutputAllowed(requestedOut, input);
  if (options["--receipts"] && inside(requestedOut, resolve(options["--receipts"]))) fail("receipts file must not be inside --out");
  const cache = options["--cache"] ? await realpath(resolve(options["--cache"])) : null;
  if (cache && (inside(cache, requestedOut) || inside(requestedOut, cache))) fail("--out and --cache must not contain each other");
  if (cache && options["--receipts"] && inside(cache, resolve(options["--receipts"]))) fail("receipts file must not be inside --cache");
  const collected = options["--image"]
    ? await imageInventory(options["--image"], options["--expected-index"])
    : await rootInventory(input);
  const packages = normalizePackages(collected.inventory.packages);
  if (!packages.length) fail("no installed packages");
  const names = new Set(packages.map((pkg) => pkg.binary));
  if (names.size !== packages.length) fail("duplicate installed package identity");
  const licenseNames = new Set(collected.inventory.common.map((file) => file.name));
  const aptFiles = [...collected.inventory.apt, ...collected.inventory.sources].filter((file) => file.path !== "/etc/os-release" && file.path !== "/etc/debian_version");
  const entries = aptEntries(aptFiles);
  const indexes = [];
  const seenIndex = new Set();
  for (const entry of entries) {
    for (const component of entry.components) {
      const key = `${entry.uri}|${entry.suite}|${component}`;
      if (seenIndex.has(key)) continue;
      seenIndex.add(key);
      indexes.push(await loadIndex(entry, component));
    }
  }
  const bySource = new Map();
  for (const index of indexes) {
    for (const stanza of index.stanzas) {
      const name = one(stanza, "Package");
      const version = one(stanza, "Version");
      const directory = one(stanza, "Directory");
      if (directory.split("/").some((part) => part === "" || part === "." || part === "..")) fail(`unsafe directory for ${name}`);
      const files = parseChecksums(stanza.get("Checksums-Sha256"), `${name} ${version}`);
      const dscs = files.filter((file) => file.name.endsWith(".dsc"));
      if (dscs.length !== 1) fail(`${name} ${version} does not name exactly one .dsc`);
      const record = {
        name, version, directory, index,
        dsc: { ...dscs[0], url: `${index.archive}/${directory}/${dscs[0].name}` },
        files: files.filter((file) => file.name !== dscs[0].name).map((file) => ({ ...file, url: `${index.archive}/${directory}/${file.name}` })),
      };
      const key = `${name}\t${version}`;
      const variants = bySource.get(key) ?? [];
      variants.push(record);
      bySource.set(key, variants);
    }
  }
  const fileIdentity = (record) => [record.dsc, ...record.files].map((file) => `${file.name} ${file.sha256} ${file.bytes}`).sort().join("\n");
  const needed = new Map();
  for (const pkg of packages) {
    const key = `${pkg.sourcePackage}\t${pkg.sourceVersion}`;
    const variants = bySource.get(key);
    if (!variants?.length) fail(`no configured source index contains ${pkg.sourcePackage} ${pkg.sourceVersion} for ${pkg.binary}`);
    const identities = new Set(variants.map(fileIdentity));
    if (identities.size !== 1) fail(`configured indexes disagree for ${pkg.sourcePackage} ${pkg.sourceVersion}`);
    const [chosen, ...rest] = variants;
    needed.set(key, {
      ...chosen,
      alsoIn: rest.map((variant) => ({
        indexUrl: variant.index.url,
        directory: variant.directory,
        dscUrl: variant.dsc.url,
      })),
    });
  }
  const receipts = options["--receipts"] ? await loadReceipts(resolve(options["--receipts"])) : null;
  await mkdir(dirname(requestedOut), { recursive: true });
  await mkdir(requestedOut, { recursive: false });
  try {
    const noticePackages = [];
    for (const pkg of packages.sort((a, b) => a.binary < b.binary ? -1 : 1)) {
      const id = safeSegment(pkg.binary.replaceAll(":", "_"), "package id");
      const noticePath = `notices/packages/${id}/copyright`;
      await mkdir(join(requestedOut, dirname(noticePath)), { recursive: true });
      await writeFile(join(requestedOut, noticePath), pkg.copyrightBytes, { flag: "wx" });
      const text = pkg.copyrightBytes.toString("utf8");
      const version = splitVersion(pkg.sourceVersion);
      noticePackages.push({
        name: pkg.binary,
        package: pkg.name,
        version: pkg.version,
        architecture: pkg.architecture,
        status: pkg.status,
        sourcePackage: pkg.sourcePackage,
        sourceVersion: pkg.sourceVersion,
        epoch: version.epoch,
        copyright: {
          path: pkg.copyright.path,
          realpath: pkg.copyright.realpath,
          docDirectorySymlink: pkg.docLink,
          sha256: pkg.copyright.sha256,
          bytes: pkg.copyright.bytes,
          noticePath,
        },
        ...referencedLicenses(text, licenseNames),
        sourcePath: `sources/${safeSegment(needed.get(`${pkg.sourcePackage}\t${pkg.sourceVersion}`).dsc.name.replace(/\.dsc$/, ""), "source directory")}`,
      });
    }
    const commonLicenses = [];
    for (const file of collected.inventory.common) {
      const name = safeSegment(file.name, "common license");
      const bytes = Buffer.from(file.base64, "base64");
      if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) fail(`common license hash changed for ${name}`);
      const noticePath = `notices/common-licenses/${name}`;
      await mkdir(join(requestedOut, dirname(noticePath)), { recursive: true });
      await writeFile(join(requestedOut, noticePath), bytes, { flag: "wx" });
      commonLicenses.push({ name, path: `/usr/share/common-licenses/${name}`, realpath: file.realpath, symlink: file.symlink, sha256: file.sha256, bytes: file.bytes, noticePath });
    }
    const osRelease = collected.inventory.apt.find((file) => file.path === "/etc/os-release");
    const debianVersion = collected.inventory.apt.find((file) => file.path === "/etc/debian_version");
    if (!osRelease?.text || !debianVersion?.text) fail("missing os-release or debian_version");
    const sourceRecords = await pool([...needed.values()], 2, async (record) => {
      const directory = safeSegment(record.dsc.name.replace(/\.dsc$/, ""), "source directory");
      const sourceDir = join(requestedOut, "sources", directory);
      await mkdir(sourceDir, { recursive: true });
      const dscPath = join(sourceDir, record.dsc.name);
      const reused = receiptAgrees(receipts?.map.get(`${record.name}\t${record.version}`), record);
      const cachedDsc = cache ? await copyCachedFile(cache, directory, dscPath, record.dsc) : null;
      let finalUrl = null;
      if (!cachedDsc && reused) await writeFile(dscPath, reused, { flag: "wx" });
      else if (!cachedDsc && !reused) finalUrl = (await downloadFile(record.dsc.url, dscPath, record.dsc)).finalUrl;
      const dscBytes = await readFile(dscPath);
      if (sha256(dscBytes) !== record.dsc.sha256 || dscBytes.length !== record.dsc.bytes) fail(`written .dsc hash changed for ${record.name}`);
      const signed = clearsignBody(dscBytes.toString("utf8"));
      const dscStanza = parseDeb822(signed.body, false)[0];
      if (!dscStanza || one(dscStanza, "Source") !== record.name || one(dscStanza, "Version") !== record.version) {
        fail(`.dsc identity does not match index for ${record.name} ${record.version}`);
      }
      const dscFiles = parseChecksums(dscStanza.get("Checksums-Sha256"), `${record.name} .dsc`);
      if (!sameFileSet({ directory: record.directory, files: record.files }, { directory: record.directory, files: dscFiles })) {
        fail(`.dsc checksums do not match the source index for ${record.name} ${record.version}`);
      }
      const files = [{
        name: record.dsc.name,
        role: "source-control",
        url: record.dsc.url,
        sha256: record.dsc.sha256,
        bytes: record.dsc.bytes,
        path: `sources/${directory}/${record.dsc.name}`,
        finalUrl,
        byteSource: cachedDsc ? "cache" : reused ? "receipt" : "network",
        clearsigned: signed.clearsigned,
        signatureTrustVerified: false,
        indexMatch: true,
        dscMatch: true,
      }];
      const downloaded = await pool(record.files, 3, async (file) => {
        safeSegment(file.name, "source file");
        const cached = cache ? await copyCachedFile(cache, directory, join(sourceDir, file.name), file) : null;
        const saved = cached ?? await downloadFile(file.url, join(sourceDir, file.name), file);
        return {
          name: file.name,
          role: fileRole(file.name),
          url: file.url,
          finalUrl: saved.finalUrl,
          sha256: saved.sha256,
          bytes: saved.bytes,
          path: `sources/${directory}/${file.name}`,
          byteSource: saved.byteSource,
          signatureTrustVerified: false,
          indexMatch: true,
          dscMatch: true,
        };
      });
      return {
        name: record.name,
        version: record.version,
        epoch: splitVersion(record.version).epoch,
        format: one(dscStanza, "Format"),
        directory: record.directory,
        indexUrl: record.index.url,
        indexSha256: record.index.sha256,
        releaseUrl: record.index.releaseUrl,
        alsoIn: record.alsoIn,
        path: `sources/${directory}`,
        files: [...files, ...downloaded],
        installedBinaries: noticePackages.filter((pkg) => pkg.sourcePackage === record.name && pkg.sourceVersion === record.version).map((pkg) => ({
          name: pkg.name, version: pkg.version, architecture: pkg.architecture,
        })),
      };
    });
    for (const source of sourceRecords) {
      for (const file of source.files) {
        const bytes = await readFile(join(requestedOut, file.path));
        if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) fail(`output hash mismatch for ${file.path}`);
      }
      if (!source.installedBinaries.length) fail(`source ${source.name} is not related to an installed package`);
    }
    for (const pkg of noticePackages) {
      const bytes = await readFile(join(requestedOut, pkg.copyright.noticePath));
      if (sha256(bytes) !== pkg.copyright.sha256) fail(`notice hash mismatch for ${pkg.name}`);
    }
    const aptText = aptFiles.map((file) => file.text ?? "").join("\n");
    const snapshotComment = /(?:^|\n)\s*#[^\n]*snapshot\.debian\.org/.test(aptText);
    const configuredSnapshot = entries.some((entry) => entry.uri.includes("snapshot.debian.org"));
    const manifest = {
      schemaVersion: 1,
      notLicenseApproval: true,
      finalReleaseProvenance: false,
      purpose: "installed-debian-corresponding-source-and-notices",
      image: collected.image,
      osRelease: { path: osRelease.path, realpath: osRelease.realpath, sha256: osRelease.sha256, bytes: osRelease.bytes },
      debianVersion: debianVersion.text.trim(),
      apt: aptFiles.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
      snapshotCommentIgnored: snapshotComment && !configuredSnapshot,
      indexes: indexes.map((index) => ({
        url: index.url, sha256: index.sha256, bytes: index.bytes, releaseUrl: index.releaseUrl, compressedSha256: index.compressedSha256,
      })),
      receipts: receipts ? { sha256: receipts.sha256, bytes: receipts.bytes } : null,
      packages: noticePackages,
      commonLicenses,
      sources: sourceRecords.sort((a, b) => a.name < b.name ? -1 : 1),
      supplementalLicenseCrossReferences: supplementalLicenseCrossReferences(noticePackages, commonLicenses),
      coverage: {
        installedPackages: noticePackages.length,
        mappedPackages: noticePackages.length,
        unmappedPackages: [],
        sourcePackages: sourceRecords.length,
        sourceFiles: sourceRecords.reduce((sum, source) => sum + source.files.length, 0),
        hashMismatches: [],
        docDirectorySymlinks: noticePackages.filter((pkg) => pkg.copyright.docDirectorySymlink).length,
        unresolvedCommonLicenseReferences: noticePackages.flatMap((pkg) => pkg.unresolvedCommonLicenseReferences.map((name) => ({ package: pkg.name, reference: name }))),
      },
      signatureTrustVerified: false,
    };
    await writeFile(join(requestedOut, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const cachedFiles = sourceRecords.reduce((sum, source) => sum + source.files.filter((file) => file.byteSource === "cache" || file.byteSource === "receipt").length, 0);
    const receipt = [
      "# Debian source preparation receipt",
      "",
      `- Installed package notices: ${noticePackages.length}`,
      `- Source packages: ${sourceRecords.length}`,
      `- Indexed source files: ${sourceRecords.reduce((sum, source) => sum + source.files.length, 0)}`,
      `- Common-license texts: ${commonLicenses.length}`,
      `- Source files reused from verified receipts/cache: ${cachedFiles}`,
      `- Original unresolved common-license references: ${manifest.coverage.unresolvedCommonLicenseReferences.length}`,
      `- OpenPGP signature trust verified: ${manifest.signatureTrustVerified}`,
      `- Final release provenance: ${manifest.finalReleaseProvenance}`,
      "",
      "The manifest and per-file SHA-256 values are the integrity record. This receipt does not assert OpenPGP trust, license approval, native build/relink completion, or final release provenance.",
      "",
    ].join("\n");
    await writeFile(join(requestedOut, "receipt.md"), receipt, { flag: "wx" });
    return {
      output: requestedOut,
      packages: manifest.coverage.installedPackages,
      sources: manifest.coverage.sourcePackages,
      sourceFiles: manifest.coverage.sourceFiles,
      notices: noticePackages.length,
      commonLicenses: commonLicenses.length,
      unresolvedCommonLicenseReferences: manifest.coverage.unresolvedCommonLicenseReferences.length,
      receiptFilesReused: sourceRecords.reduce((sum, source) => sum + source.files.filter((file) => file.byteSource === "receipt").length, 0),
      cacheFilesReused: sourceRecords.reduce((sum, source) => sum + source.files.filter((file) => file.byteSource === "cache").length, 0),
      sourceFilesReused: cachedFiles,
      container: collected.container ?? null,
    };
  } catch (error) {
    await rm(requestedOut, { recursive: true, force: true });
    throw error;
  }
};

try {
  const summary = await prepare(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error instanceof DebianSourceError ? error.message : error);
  process.exitCode = 1;
}
