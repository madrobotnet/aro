import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

const directories: string[] = [];
const script = path.resolve(import.meta.dir, "../../..", "scripts/verify-release.mjs");
const selected = [
  "compose.yml", "docker/postgres/production/01-app-role.sql",
  "README.md", "README.ko.md", "docs/SETUP.md", "docs/SETUP.ko.md", "LICENSE",
  "THIRD_PARTY_NOTICES.md", "SECURITY.md", "CONTRIBUTING.md", "SUPPORT.md",
  "CHANGELOG.md", "docs/RELEASING.md", "docs/ARCHITECTURE.md",
  "docs/BACKUP.md", "docs/BACKUP.ko.md", "scripts/backup.mjs",
  "scripts/restore-check.mjs", "scripts/backup/common.mjs",
  "docs/SEMANTIC-SEARCH.md", "docs/images/irang-mark.svg",
  "docs/images/irang-workbench.png", "docs/images/irang-workbench.ko.png",
];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("assembles only intentional installation members and changes only the image default", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "irang-release-assets-"));
  directories.push(directory);
  const root = path.join(directory, "source");
  const out = path.join(directory, "assets");
  const version = "2.3.0";
  const revision = "1".repeat(40);
  const registry = "ghcr.io/madrobotnet/irang";
  const compose = {
    services: {
      app: { image: `\${IRANG_IMAGE:-${registry}:${version}}`, environment: { EMBEDDING_BASE_URL: "${EMBEDDING_BASE_URL:-}" } },
      db: { image: "fixture-db", volumes: ["postgres-data:/var/lib/postgresql", "./docker/postgres/production:/init:ro"] },
    },
    volumes: { "postgres-data": {}, "app-data": {} },
  };
  const composeText = Bun.YAML.stringify(compose);
  for (const member of [...selected, "docs/audit-http.json", "docs/research/local.md", "docs/untracked.md", ".env"]) {
    const file = path.join(root, member);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, member === "compose.yml" ? composeText : `fixture:${member}`);
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
        "org.opencontainers.image.title": "Aro",
        "org.opencontainers.image.source": "https://github.com/madrobotnet/aro",
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
  const archive = new Bun.Archive(await Bun.file(path.join(out, `irang-${version}-install.tar.gz`)).bytes());
  const files = await archive.files();
  expect([...files.keys()].sort()).toEqual([...selected.map((member) => `irang/${member}`), "irang/release.json"].sort());
  const archivedCompose = z.object({
    services: z.object({ app: z.object({ image: z.string() }).passthrough() }).passthrough(),
  }).passthrough().parse(Bun.YAML.parse(await files.get("irang/compose.yml")!.text()));
  expect(archivedCompose.services.app.image).toBe(`\${IRANG_IMAGE:-${registry}:${version}@${indexDigest}}`);
  archivedCompose.services.app.image = compose.services.app.image;
  expect(archivedCompose).toEqual(compose);
  const release = JSON.parse(await files.get("irang/release.json")!.text());
  expect(release.revision).toBe(revision);
  expect(release.indexDigest).toBe(indexDigest);
  expect(release.compose.sourceSha256).toBe(createHash("sha256").update(composeText).digest("hex"));
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
