import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const snapshot = "20261005T000000Z";
const version = "2026c-0+deb12u1";

async function prepareFixture(mode, useSnapshot = true) {
  const root = await mkdtemp(join(tmpdir(), "aro-debian-snapshot-"));
  const requests = [];
  const source = Buffer.from("corresponding source bytes\n");
  const sourceName = "tzdata_2026c.orig.tar.gz";
  const dscName = `tzdata_${version}.dsc`;
  const dsc = Buffer.from(`Format: 3.0 (quilt)\nSource: tzdata\nVersion: ${version}\nChecksums-Sha256:\n ${sha(source)} ${source.length} ${sourceName}\n`);
  const stanza = selected => `Package: tzdata\nVersion: ${selected}\nDirectory: pool/updates/main/t/tzdata\nChecksums-Sha256:\n ${sha(dsc)} ${dsc.length} ${dscName}\n ${sha(source)} ${source.length} ${sourceName}\n`;
  const oldIndex = gzipSync(stanza(mode === "missing" ? "2026b-0+deb12u1" : version));
  const liveIndex = gzipSync(stanza(mode === "live" ? version : "2026e-0+deb12u1"));
  const farm = new Map();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(new URL(request.url).searchParams.get("url"));
      requests.push(url.href);
      if (url.pathname.startsWith("/file/")) {
        const bytes = farm.get(url.pathname);
        return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
      }
      const historical = url.hostname === "snapshot.debian.org";
      const index = historical ? oldIndex : liveIndex;
      let bytes;
      if (url.pathname.endsWith("/Release")) {
        bytes = Buffer.from(`SHA256:\n ${sha(index)} ${index.length} main/source/Sources.gz\n`);
      } else if (url.pathname.endsWith("/Sources.gz")) {
        bytes = historical && mode === "index-hash" ? Buffer.from("corrupt index") : index;
      } else if (url.pathname.endsWith(`/${dscName}`)) {
        bytes = dsc;
      } else if (url.pathname.endsWith(`/${sourceName}`)) {
        bytes = mode === "source-hash" ? Buffer.from("corrupt source") : source;
      } else {
        return new Response("missing", { status: 404 });
      }
      if (historical) {
        const name = url.pathname.endsWith("/Sources.gz") ? sha(bytes) : encodeURIComponent(url.pathname.split("/").at(-1));
        const location = `/file/${createHash("sha1").update(bytes).digest("hex")}/${name}`;
        farm.set(location, bytes);
        return new Response(null, { status: 302, headers: {
          location: mode === "cross-host" ? `https://example.org${location}` :
            mode === "wrong-path" ? "/unrelated/Release" : location,
        } });
      }
      return new Response(bytes);
    },
  });
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    const copyright = Buffer.from("fixture copyright\n");
    const inventory = {
      packages: [{
        binary: "tzdata", name: "tzdata", version, architecture: "all",
        sourcePackage: "tzdata", sourceVersion: version, status: "ii",
        copyright: { path: "/usr/share/doc/tzdata/copyright", realpath: "/usr/share/doc/tzdata/copyright",
          bytes: copyright.length, sha256: sha(copyright), base64: copyright.toString("base64") },
      }],
      common: [],
      apt: [
        { path: "/etc/os-release", text: "ID=debian\n" },
        { path: "/etc/debian_version", text: "12.12\n" },
      ],
      sources: [{ path: "/etc/apt/sources.list.d/debian.sources",
        text: `Types: deb\n# https://snapshot.debian.org/archive/debian-security/${snapshot}\nURIs: https://deb.debian.org/debian-security\nSuites: bookworm-security\nComponents: main\n` }],
    };
    const id = `sha256:${"a".repeat(64)}`;
    await writeFile(join(bin, "docker"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "image") console.log(JSON.stringify({ Id: ${JSON.stringify(id)}, Os: "linux", Architecture: "arm64" }));
else if (args[0] === "run") console.log(${JSON.stringify(JSON.stringify(inventory))});
else if (!["rm", "ps"].includes(args[0])) process.exitCode = 1;
`, { mode: 0o700 });
    // Redirect only the transport to a real HTTP fixture. The production CLI
    // still handles original URLs, redirects, hashes, DSC parsing and disk IO.
    const preload = join(root, "transport.mjs");
    await writeFile(preload, `const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => realFetch(${JSON.stringify(server.url.href)} + "?url=" + encodeURIComponent(String(url)), options);
`);
    const out = join(root, "out");
    const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload,
      new URL("../../scripts/prepare-redistribution-debian.mjs", import.meta.url).pathname,
      "--image", "fixture:qa", "--expected-index", id, "--out", out,
      ...(useSnapshot ? ["--snapshot", snapshot] : [])], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    const manifest = code === 0 ? JSON.parse(await readFile(join(out, "manifest.json"), "utf8")) : null;
    const saved = manifest ? await readFile(join(out, manifest.sources[0].files[1].path)) : null;
    return { code, stdout, stderr, manifest, saved, source, requests };
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

test("missing live source resolves the exact version through a pinned snapshot", async () => {
  // Given a rolling index that no longer includes the installed version.
  // When the real preparation CLI is explicitly given the matching snapshot.
  const result = await prepareFixture("fallback");
  // Then the exact source bytes and their historical provenance are retained.
  expect(result.code, result.stderr).toBe(0);
  expect(result.saved).toEqual(result.source);
  expect(result.manifest.sources[0].version).toBe(version);
  expect(result.manifest.sources[0].releaseUrl).toBe(`https://snapshot.debian.org/archive/debian-security/${snapshot}/dists/bookworm-security/Release`);
  expect(result.manifest.sources[0].files.every(file => file.indexMatch && file.dscMatch)).toBe(true);
  expect(result.manifest.coverage.unmappedPackages).toEqual([]);
});

test("available live source does not contact the snapshot", async () => {
  // Given a matching live version, when preparing with fallback enabled.
  const result = await prepareFixture("live");
  // Then live source preparation succeeds without a historical dependency.
  expect(result.code, result.stderr).toBe(0);
  expect(result.saved).toEqual(result.source);
  expect(result.requests.some(url => url.includes("snapshot.debian.org"))).toBe(false);
});

test("snapshot comments alone cannot enable historical sources", async () => {
  // Given only a commented snapshot, when the live source is missing.
  const result = await prepareFixture("fallback", false);
  // Then the default remains fail-closed rather than trusting the comment.
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`no configured source index contains tzdata ${version}`);
  expect(result.requests.some(url => url.includes("snapshot.debian.org"))).toBe(false);
});

for (const [mode, error] of [
  ["missing", `no configured source index contains tzdata ${version}`],
  ["index-hash", "source index hash changed"],
  ["source-hash", "hash or size mismatch"],
  ["cross-host", "refusing cross-host redirect"],
  ["wrong-path", "refusing path-changing redirect"],
]) {
  test(`snapshot preparation rejects ${mode}`, async () => {
    // Given missing or untrusted historical source data.
    // When the real CLI resolves and downloads the source.
    const result = await prepareFixture(mode);
    // Then no successful source manifest can escape the integrity checks.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(error);
    expect(result.manifest).toBeNull();
  });
}
