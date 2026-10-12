#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, lstat, mkdir, writeFile, realpath } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verifySourceAssets } from "../distribution/release/restore.mjs";

import { releasePrefix, releaseRegistry, installArchiveName } from "./release-names.mjs";
const source = "https://github.com/madrobotnet/aro";
const required = ["compose.yml", "docker/postgres/production/01-app-role.sql",
  "README.md", "README.ko.md", "docs/SETUP.md", "docs/SETUP.ko.md", "LICENSE",
  "THIRD_PARTY_NOTICES.md", "SECURITY.md", "CONTRIBUTING.md", "SUPPORT.md",
  "CHANGELOG.md", "docs/RELEASING.md", "docs/ARCHITECTURE.md",
  "docs/BACKUP.md", "docs/BACKUP.ko.md", "scripts/backup.mjs",
  "scripts/restore-check.mjs", "scripts/backup/common.mjs",
  "docs/SEMANTIC-SEARCH.md"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = (message) => { throw new Error(message); };
const requireValue = (condition, message) => { if (!condition) fail(message); };
const digest = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const load = async (path) => JSON.parse(await readFile(path, "utf8"));

function identity(version, ref, revision) {
  requireValue(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), "invalid stable semver");
  requireValue(ref === `refs/tags/v${version}`, "ref/version mismatch");
  requireValue(/^[a-f0-9]{40}$/.test(revision), "invalid source revision");
}

function labels(actual, version, revision) {
  for (const [key, expected] of Object.entries({
    version, revision, licenses: "NOASSERTION",
  })) requireValue(actual?.[`org.opencontainers.image.${key}`] === expected, `OCI ${key} mismatch`);
  const legacy = releasePrefix(version) === "irang";
  requireValue((legacy ? ["Irang", "Aro"] : ["Aro"]).includes(actual?.["org.opencontainers.image.title"]), "OCI title mismatch");
  requireValue((legacy ? [source, "https://github.com/madrobotnet/irang"] : [source]).includes(actual?.["org.opencontainers.image.source"]), "OCI source mismatch");
}

function safePath(path) {
  requireValue(typeof path === "string" && path.length > 0 && !path.includes("\\") &&
    !path.startsWith("/") && path.split("/").every((part) => part && part !== "." && part !== ".."),
  "unsafe asset path");
  requireValue(!/(^|\/)(\.env[^/]*|\.git|\.omo|\.data|node_modules|auth|credentials|private|id_rsa|id_ed25519)(\/|$)/i.test(path),
    "private asset path");
}

function publicBytes(bytes) {
  // These exact loopback credentials belong to the documented development fixture.
  const text = bytes.toString().replace(/postgres:\/\/(?:second_brain:second_brain@127\.0\.0\.1:55432\/second_brain|aro:aro@127\.0\.0\.1:55432\/aro)(?:_test)?(?=$|[\s`"'])/g, "");
  requireValue(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|(?:\/home\/ubuntu\/|\/Users\/[^/\s]+\/)|(?:postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@)/.test(text),
    "credential or private path in asset");
}

async function file(root, path) {
  safePath(path);
  const base = await realpath(root);
  const full = join(base, path);
  for (const part of path.split("/")) {
    // Inspect every ancestor, not merely the final file.
    root = join(root, part);
    requireValue(!(await lstat(root)).isSymbolicLink(), "symlink asset");
  }
  requireValue((await lstat(full)).isFile(), "asset is not regular file");
  requireValue(relative(base, await realpath(full)) === path, "asset escapes root");
  const bytes = await readFile(full);
  publicBytes(bytes);
  return bytes;
}

async function validate(root, version, ref, revision) {
  identity(version, ref, revision);
  const registry = releaseRegistry(version);
  const pkg = await load(join(root, "package.json"));
  requireValue(pkg.version === version && pkg.private === true, "package identity/private mismatch");
  const text = (await file(root, "compose.yml")).toString();
  const parsed = Bun.YAML.parse(text);
  const imageDefault = releasePrefix(version) === "irang" ? `\${IRANG_IMAGE:-${registry}:${version}}` : `\${ARO_IMAGE:-\${IRANG_IMAGE:-${registry}:${version}}}`;
  requireValue(parsed.services?.app?.image === imageDefault, "Compose image default mismatch");
  requireValue(!Object.hasOwn(parsed.services.app, "build"), "Compose must be image-only");
  return { text, parsed };
}

function metadata(input, version, revision) {
  const registry = releaseRegistry(version);
  requireValue(input.schemaVersion === 1 && input.version === version &&
    input.revision === revision && input.ref === `refs/tags/v${version}`, "metadata identity mismatch");
  const indexBytes = Buffer.from(input.indexRaw);
  const index = JSON.parse(input.indexRaw);
  requireValue(digest(input.indexDigest) && `sha256:${hash(indexBytes)}` === input.indexDigest, "index byte digest mismatch");
  requireValue(index.schemaVersion === 2 && Array.isArray(index.manifests), "invalid OCI index");
  requireValue(Array.isArray(input.receipts) && input.receipts.length === 2, "two native receipts required");
  const platforms = {};
  const attestations = [];
  for (const descriptor of index.manifests) {
    requireValue(digest(descriptor.digest), "invalid descriptor digest");
    const platform = `${descriptor.platform?.os}/${descriptor.platform?.architecture}`;
    if (platform === "unknown/unknown") {
      requireValue(descriptor.annotations?.["vnd.docker.reference.type"] === "attestation-manifest", "unknown descriptor is not attestation");
      attestations.push(descriptor);
      continue;
    }
    requireValue(["linux/amd64", "linux/arm64"].includes(platform) &&
      !descriptor.platform.variant && !platforms[platform], "unsupported or duplicate platform");
    platforms[platform] = descriptor.digest;
  }
  requireValue(Object.keys(platforms).length === 2, "missing native platform");
  for (const [platform, runnableDigest] of Object.entries(platforms)) {
    const receipts = input.receipts.filter((r) => r.platform === platform);
    requireValue(receipts.length === 1, "missing or duplicate native receipt");
    const r = receipts[0];
    requireValue(r.revision === revision && r.version === version && r.runnableDigest === runnableDigest &&
      digest(r.buildDigest) && r.image === `${registry}@${r.buildDigest}` &&
      r.native === true && r.pull === "PASS" && r.cleanup === "PASS" &&
      Array.isArray(r.checks) && r.checks.length > 0 && r.checks.every((c) => c.status === "PASS"), "native receipt mismatch or failure");
    labels(r.labels, version, revision);
    if (r.buildDigest !== runnableDigest) {
      const raw = input.buildIndexes?.[r.buildDigest];
      requireValue(typeof raw === "string" && `sha256:${hash(Buffer.from(raw))}` === r.buildDigest,
        "build index byte digest mismatch");
      const runnable = JSON.parse(raw).manifests?.filter((d) => d.platform?.os !== "unknown");
      requireValue(runnable?.length === 1 && runnable[0].digest === runnableDigest &&
        `${runnable[0].platform?.os}/${runnable[0].platform?.architecture}` === platform,
      "tested build index/runnable mismatch");
    }
    const associated = attestations.filter((a) => a.annotations["vnd.docker.reference.digest"] === runnableDigest);
    requireValue(associated.length > 0, "missing associated attestation");
    const statements = associated.flatMap((a) => {
      const payload = input.attestations?.[a.digest];
      requireValue(Array.isArray(payload) && payload.length > 0, "missing attestation statements");
      for (const statement of payload) {
        requireValue(statement._type === "https://in-toto.io/Statement/v0.1" ||
          statement._type === "https://in-toto.io/Statement/v1", "invalid attestation statement");
        requireValue(statement.subject?.length > 0 &&
          statement.subject.every((s) => s.digest?.sha256 === runnableDigest.slice(7)), "attestation subject mismatch");
      }
      return payload;
    });
    const provenance = statements.find((s) => /^https:\/\/slsa.dev\/provenance\/v[01](?:\.\d+)?$/.test(s.predicateType));
    const materials = provenance?.predicate?.materials ??
      provenance?.predicate?.buildDefinition?.resolvedDependencies;
    requireValue(materials?.some((m) => m.digest?.sha1 === revision), "missing revision-linked provenance");
    requireValue(statements.some((s) => s.predicateType === "https://spdx.dev/Document" &&
      s.predicate?.spdxVersion && s.predicate?.packages?.length > 0), "missing nonempty SPDX SBOM");
  }
  requireValue(attestations.every((a) => Object.values(platforms).includes(a.annotations["vnd.docker.reference.digest"])), "orphan attestation");
  return { platforms, indexDigest: input.indexDigest };
}

async function assemble(root, out, input, version, ref, revision) {
  const compose = await validate(root, version, ref, revision);
  const verified = metadata(input, version, revision);
  const prefix = releasePrefix(version);
  const paths = [...required, `docs/images/${prefix}-mark.svg`];
  if (prefix === "irang") paths.push("docs/images/irang-workbench.png", "docs/images/irang-workbench.ko.png");
  const files = {};
  for (const path of paths.sort()) files[`${prefix}/${path}`] = await file(root, path);
  const immutable = `${releaseRegistry(version)}:${version}@${verified.indexDigest}`;
  const replacement = prefix === "irang" ? `\${IRANG_IMAGE:-${immutable}}` : `\${ARO_IMAGE:-\${IRANG_IMAGE:-${immutable}}}`;
  const original = compose.parsed.services.app.image;
  requireValue(compose.text.split(original).length === 2, "ambiguous Compose image replacement");
  const transformed = compose.text.replace(original, replacement);
  const parsed = Bun.YAML.parse(transformed);
  parsed.services.app.image = original;
  requireValue(isDeepStrictEqual(parsed, compose.parsed), "Compose fields changed");
  files[`${prefix}/compose.yml`] = Buffer.from(transformed);
  files[`${prefix}/release.json`] = json({ schemaVersion: 1, version, ref, revision, image: immutable, ...verified,
    compose: { sourceSha256: hash(Buffer.from(compose.text)), archiveSha256: hash(files[`${prefix}/compose.yml`]) } });
  const manifest = { schemaVersion: 1, version, revision, indexDigest: verified.indexDigest,
    files: Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) })) };
  // No self-hash: the external checksum list covers manifest and archive bytes.
  const archive = Buffer.from(await new Bun.Archive(files, { compress: "gzip" }).bytes());
  const name = installArchiveName(version);
  await mkdir(out, { recursive: false });
  await writeFile(join(out, name), archive, { flag: "wx" });
  const manifestBytes = json(manifest);
  await writeFile(join(out, "archive-manifest.json"), manifestBytes, { flag: "wx" });
  await writeFile(join(out, "SHA256SUMS"), `${hash(archive)}  ${name}\n${hash(manifestBytes)}  archive-manifest.json\n`, { flag: "wx" });
  return { ...verified, archive: name, sha256: hash(archive) };
}

async function checksums(root) {
  const largeSources = new Set();
  const names = await readdir(root);
  for (const name of names.filter((name) => /^(?:irang|aro)-\d+\.\d+\.\d+-sources-linux-(amd64|arm64)-index\.json$/.test(name))) {
    const bytes = await file(root, name);
    const index = await verifySourceAssets(root, name, hash(bytes));
    for (const asset of index.assets) largeSources.add(asset.name);
  }
  const text = await readFile(join(root, "SHA256SUMS"), "utf8");
  const seen = new Set();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    requireValue(match, "invalid checksum line");
    const [, expected, path] = match;
    safePath(path);
    requireValue(path !== "SHA256SUMS" && !seen.has(path), "duplicate/self checksum");
    seen.add(path);
    let actualHash;
    if (largeSources.has(path)) {
      // The source verifier already checks regular paths, every selected byte,
      // piece ownership and manifest association. Do not buffer multi-GB pieces.
      const checksum = createHash("sha256");
      for await (const chunk of createReadStream(join(root, path))) checksum.update(chunk);
      actualHash = checksum.digest("hex");
    } else actualHash = hash(await file(root, path));
    requireValue(actualHash === expected, "asset checksum changed");
  }
  requireValue(seen.size > 0, "empty checksums");
  const actual = await readdir(root);
  requireValue(actual.every((path) => path === "SHA256SUMS" || seen.has(path)), "unchecked asset");
  return { assets: seen.size };
}

async function sources(root, input, version, revision) {
  metadata(input, version, revision);
  for (const receipt of input.receipts) {
    const binding = receipt.sources;
    requireValue(binding && /^[a-f0-9]{64}$/.test(binding.indexSha256) &&
      /^[a-f0-9]{64}$/.test(binding.materialManifestSha256), "missing native source binding");
    await verifySourceAssets(root, binding.indexName, binding.indexSha256, {
      version, revision, platform: receipt.platform,
      materialManifestSha256: binding.materialManifestSha256,
    });
  }
  return { platforms: input.receipts.length };
}

try {
  const [command, ...args] = process.argv.slice(2);
  const allowed = {
    validate: ["root", "version", "ref", "revision"],
    image: ["inspect", "version", "ref", "revision", "platform"],
    verify: ["metadata", "version", "ref", "revision"],
    assemble: ["root", "out", "metadata", "version", "ref", "revision"],
    checksums: ["root"],
    sources: ["root", "metadata", "version", "ref", "revision"],
  }[command];
  requireValue(allowed, "usage: verify-release.mjs validate|image|verify|assemble|checksums --<required-option> <value>");
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    requireValue(args[i].startsWith("--") && allowed.includes(key) && !options[key] &&
      args[i + 1] && !args[i + 1].startsWith("--"), "unknown, duplicate or missing option");
    options[key] = args[i + 1];
  }
  requireValue(allowed.every((key) => options[key]), `required options: ${allowed.join(", ")}`);
  const { root, out, version, ref, revision } = options;
  let result;
  if (command === "checksums") result = await checksums(resolve(root));
  else {
    identity(version, ref, revision);
    if (command === "validate") { await validate(resolve(root), version, ref, revision); result = { version, revision }; }
    if (command === "image") {
      const raw = await load(options.inspect);
      const image = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
      requireValue(["linux/amd64", "linux/arm64"].includes(options.platform) &&
        `${image.Os}/${image.Architecture}` === options.platform, "local image platform mismatch");
      labels(image.Config?.Labels, version, revision);
      result = { id: image.Id, platform: options.platform, version, revision };
    }
    if (command === "verify") result = metadata(await load(options.metadata), version, revision);
    if (command === "sources") result = await sources(resolve(root), await load(options.metadata), version, revision);
    if (command === "assemble") result = await assemble(resolve(root), resolve(out), await load(options.metadata), version, ref, revision);
  }
  console.log(JSON.stringify({ status: "PASS", ...result }));
} catch (error) {
  console.error(`verify-release: ${error.message}`);
  process.exitCode = 1;
}
