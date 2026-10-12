import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

const directories: string[] = [];
const script = path.resolve(import.meta.dir, "../../..", "scripts/verify-release.mjs");
const selected = [
  "compose.yml", "docker/postgres/production/01-app-role.sql",
  "README.md", "README.ko.md", "docs/SETUP.md", "docs/SETUP.ko.md", "LICENSE",
  "THIRD_PARTY_NOTICES.md", "SECURITY.md", "CONTRIBUTING.md", "SUPPORT.md",
  "CHANGELOG.md", "docs/RELEASING.md", "docs/ARCHITECTURE.md",
  "docs/BACKUP.md", "docs/BACKUP.ko.md", "scripts/backup.mjs",
  "scripts/restore-check.mjs", "scripts/backup/common.mjs",
  "docs/SEMANTIC-SEARCH.md",
];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

for (const { version, prefix, registry, title, source } of [
  { version: "2.3.2", prefix: "irang", registry: "ghcr.io/madrobotnet/irang", title: "Irang", source: "https://github.com/madrobotnet/irang" },
  { version: "2.4.0", prefix: "aro", registry: "ghcr.io/madrobotnet/aro", title: "Aro", source: "https://github.com/madrobotnet/aro" },
]) {
test(`${version} assembles intentional members and verifies native source bindings`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "irang-release-assets-"));
  directories.push(directory);
  const root = path.join(directory, "source");
  const out = path.join(directory, "assets");
  const revision = "1".repeat(40);
  const members = [...selected, `docs/images/${prefix}-mark.svg`, ...(prefix === "irang" ? ["docs/images/irang-workbench.png", "docs/images/irang-workbench.ko.png"] : [])];
  const imageDefault = (image: string) => prefix === "irang" ? `\${IRANG_IMAGE:-${image}}` : `\${ARO_IMAGE:-\${IRANG_IMAGE:-${image}}}`;
  const compose = {
    services: {
      app: { image: imageDefault(`${registry}:${version}`), environment: { EMBEDDING_BASE_URL: "${EMBEDDING_BASE_URL:-}" } },
      db: { image: "fixture-db", volumes: ["postgres-data:/var/lib/postgresql", "./docker/postgres/production:/init:ro"] },
    },
    volumes: { "postgres-data": {}, "app-data": {} },
  };
  const composeText = Bun.YAML.stringify(compose);
  for (const member of [...members, "docs/audit-http.json", "docs/research/local.md", "docs/untracked.md", ".env"]) {
    const file = path.join(root, member);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, member === "compose.yml" ? composeText : member === "docs/SETUP.md" ? `postgres://${prefix === "aro" ? "aro:aro" : "second_brain:second_brain"}@127.0.0.1:55432/${prefix === "aro" ? "aro_test" : "second_brain_test"}` : `fixture:${member}`);
  }
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version, private: true }));

  // Synthetic parser fixtures exercise assembly only; they are not native release evidence.
  const descriptors = [];
  const receipts = [];
  const attestations: Record<string, object[]> = {};
  for (const [architecture, value] of [["amd64", "a"], ["arm64", "b"]] as const) {
    const runnableDigest = `sha256:${value.repeat(64)}`;
    const attestationDigest = `sha256:${(architecture === "amd64" ? "c" : "d").repeat(64)}`;
    descriptors.push({ digest: runnableDigest, platform: { os: "linux", architecture } });
    descriptors.push({
      digest: attestationDigest, platform: { os: "unknown", architecture: "unknown" },
      annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": runnableDigest },
    });
    receipts.push({
      platform: `linux/${architecture}`, revision, version, runnableDigest,
      buildDigest: runnableDigest, image: `${registry}@${runnableDigest}`,
      native: true, pull: "PASS", cleanup: "PASS",
      checks: [{ name: "synthetic parser fixture only", status: "PASS" }],
      labels: {
        "org.opencontainers.image.title": title,
        "org.opencontainers.image.source": source,
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.licenses": "NOASSERTION",
      },
    });
    const subject = [{ digest: { sha256: runnableDigest.slice(7) } }];
    attestations[attestationDigest] = [
      { _type: "https://in-toto.io/Statement/v1", subject, predicateType: "https://slsa.dev/provenance/v0.2",
        predicate: { materials: [{ digest: { sha1: revision } }] } },
      { _type: "https://in-toto.io/Statement/v1", subject, predicateType: "https://spdx.dev/Document",
        predicate: { spdxVersion: "SPDX-2.3", packages: [{ name: "synthetic-fixture" }] } },
    ];
  }
  const indexRaw = JSON.stringify({ schemaVersion: 2, manifests: descriptors });
  const indexDigest = `sha256:${createHash("sha256").update(indexRaw).digest("hex")}`;
  const metadata = path.join(directory, "metadata.json");
  await writeFile(metadata, JSON.stringify({
    schemaVersion: 1, version, revision, ref: `refs/tags/v${version}`,
    indexRaw, indexDigest, receipts, attestations,
  }));
  const runVerifier = async (command: string, args: string[]) => {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file", script, command, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    return { code, output, error };
  };
  const identityArgs = ["--version", version, "--ref", `refs/tags/v${version}`, "--revision", revision];
  for (const [command, args] of [["validate", ["--root", root]], ["verify", ["--metadata", metadata]]] as const) {
    const verified = await runVerifier(command, [...args, ...identityArgs]);
    expect(verified.code, verified.error).toBe(0);
  }
  const inspection = path.join(directory, "inspect.json");
  await writeFile(inspection, JSON.stringify([{ Os: "linux", Architecture: "amd64", Id: "fixture", Config: { Labels: receipts[0]?.labels } }]));
  const inspected = await runVerifier("image", ["--inspect", inspection, "--platform", "linux/amd64", ...identityArgs]);
  expect(inspected.code, inspected.error).toBe(0);
  const invalidMetadata = path.join(directory, "wrong-registry.json");
  const wrong = JSON.parse(await Bun.file(metadata).text());
  wrong.receipts[0].image = `${prefix === "aro" ? "ghcr.io/madrobotnet/irang" : "ghcr.io/madrobotnet/aro"}@${wrong.receipts[0].buildDigest}`;
  await writeFile(invalidMetadata, JSON.stringify(wrong));
  expect((await runVerifier("verify", ["--metadata", invalidMetadata, ...identityArgs])).code).toBe(1);
  const child = Bun.spawn([
    Bun.which("bun") ?? "bun", "--no-env-file", script, "assemble",
    "--root", root, "--out", out, "--metadata", metadata,
    "--version", version, "--ref", `refs/tags/v${version}`, "--revision", revision,
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(JSON.parse(stdout).status).toBe("PASS");
  const archive = new Bun.Archive(await Bun.file(path.join(out, `${prefix}-${version}-install.tar.gz`)).bytes());
  const files = await archive.files();
  expect([...files.keys()].sort()).toEqual([...members.map((member) => `${prefix}/${member}`), `${prefix}/release.json`].sort());
  const archivedCompose = z.object({
    services: z.object({ app: z.object({ image: z.string() }).passthrough() }).passthrough(),
  }).passthrough().parse(Bun.YAML.parse(await files.get(`${prefix}/compose.yml`)!.text()));
  expect(archivedCompose.services.app.image).toBe(imageDefault(`${registry}:${version}@${indexDigest}`));
  archivedCompose.services.app.image = compose.services.app.image;
  expect(archivedCompose).toEqual(compose);
  const release = JSON.parse(await files.get(`${prefix}/release.json`)!.text());
  expect(release.revision).toBe(revision);
  expect(release.indexDigest).toBe(indexDigest);
  expect(release.compose.sourceSha256).toBe(createHash("sha256").update(composeText).digest("hex"));
  const metadataValue = JSON.parse(await Bun.file(metadata).text());
  for (const receipt of metadataValue.receipts) {
    const materials = path.join(directory, receipt.platform.replace("/", "-"));
    await mkdir(path.join(materials, "app"), { recursive: true });
    await writeFile(path.join(materials, "app/input"), "fixture-source");
    const manifest = JSON.stringify({ schemaVersion: 1, kind: `${prefix}-selected-materials`, version, revision,
      platform: receipt.platform, files: [{ owner: "app", path: "input", bytes: 14, sha256: sha("fixture-source") }] });
    await writeFile(path.join(materials, "manifest.json"), manifest);
    const assets = path.join(directory, `${receipt.platform.replace("/", "-")}-assets`);
    const prepared = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file", path.resolve(import.meta.dir, "../../../scripts/prepare-source-assets.mjs"),
      "--materials", materials, "--out", assets, "--version", version, "--revision", revision, "--platform", receipt.platform, "--seal", sha(manifest)], { stdout: "pipe", stderr: "pipe" });
    const [preparedCode, preparedOutput, preparedError] = await Promise.all([prepared.exited, new Response(prepared.stdout).text(), new Response(prepared.stderr).text()]);
    expect(preparedCode, preparedError).toBe(0);
    const result = JSON.parse(preparedOutput);
    for await (const entry of new Bun.Glob("*").scan(assets)) await writeFile(path.join(out, entry), await Bun.file(path.join(assets, entry)).bytes());
    receipt.sources = { indexName: result.indexName, indexSha256: result.indexSha256, materialManifestSha256: sha(manifest) };
  }
  const boundMetadata = path.join(directory, "bound-metadata.json");
  await writeFile(boundMetadata, JSON.stringify(metadataValue));
  const bound = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file", script, "sources",
    "--root", out, "--metadata", boundMetadata, "--version", version, "--ref", `refs/tags/v${version}`, "--revision", revision], { stdout: "pipe", stderr: "pipe" });
  const [boundCode, boundOutput, boundError] = await Promise.all([bound.exited, new Response(bound.stdout).text(), new Response(bound.stderr).text()]);
  expect(boundCode, boundError).toBe(0);
  expect(JSON.parse(boundOutput).platforms).toBe(2);
  // The assembly checksum fixture below intentionally covers only its two initial assets.
  for await (const entry of new Bun.Glob("*").scan(out)) if (!entry.includes("install.tar.gz") && !["archive-manifest.json", "SHA256SUMS"].includes(entry)) await rm(path.join(out, entry));
  const check = () => Bun.spawn([
    Bun.which("bun") ?? "bun", "--no-env-file", script, "checksums", "--root", out,
  ], { stdout: "pipe", stderr: "pipe" });
  const valid = check();
  const [validExit, validOutput, validError] = await Promise.all([
    valid.exited, new Response(valid.stdout).text(), new Response(valid.stderr).text(),
  ]);
  expect(validExit, validError).toBe(0);
  expect(JSON.parse(validOutput).assets).toBe(2);
  await writeFile(path.join(out, "archive-manifest.json"), "{}\n");
  const corrupted = check();
  const [corruptExit, corruptError] = await Promise.all([
    corrupted.exited, new Response(corrupted.stderr).text(),
    new Response(corrupted.stdout).text(),
  ]);
  expect(corruptExit).toBe(1);
  expect(corruptError).toContain("asset checksum changed");
  const unbound = Bun.spawn([
    Bun.which("bun") ?? "bun", "--no-env-file", script, "sources",
    "--root", out, "--metadata", metadata, "--version", version,
    "--ref", `refs/tags/v${version}`, "--revision", revision,
  ], { stdout: "pipe", stderr: "pipe" });
  const [unboundExit, unboundError] = await Promise.all([
    unbound.exited, new Response(unbound.stderr).text(), new Response(unbound.stdout).text(),
  ]);
  expect(unboundExit).toBe(1);
  expect(unboundError).toContain("missing native source binding");
});
}
