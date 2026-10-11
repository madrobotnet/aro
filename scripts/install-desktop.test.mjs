import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installDesktop } from "./install-desktop.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function archive(extra = {}) {
  return new Bun.Archive({
    "aro/desktop-release.json": JSON.stringify({ schemaVersion: 1, version: "test",
      platform: process.platform, arch: process.arch, entrypoint: "scripts/desktop.js",
      distDirectory: ".next", sourceHash: "a".repeat(64) }),
    "aro/server.js": "// fixture",
    "aro/scripts/desktop.js": "// fixture",
    "aro/.next/BUILD_ID": "fixture-build",
    "aro/LICENSE": "fixture-license",
    "aro/THIRD_PARTY_NOTICES.md": "fixture-notices",
    ...extra,
  }, { compress: "gzip" }).bytes();
}

test("desktop archive dry-run does not write and install refuses overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "aro-installer-"));
  try {
    const bytes = await archive();
    const target = join(root, "app");
    expect(await installDesktop(bytes, hash(bytes), target, true)).toMatchObject({ writes: false });
    expect(await readdir(root)).toEqual([]);
    await installDesktop(bytes, hash(bytes), target);
    expect(await readFile(join(target, ".next/BUILD_ID"), "utf8")).toBe("fixture-build");
    await expect(installDesktop(bytes, hash(bytes), target)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("desktop archive rejects corrupt checksums and secret paths before creating output", async () => {
  const root = await mkdtemp(join(tmpdir(), "aro-installer-reject-"));
  try {
    const bytes = await archive();
    await expect(installDesktop(bytes, "0".repeat(64), join(root, "wrong"))).rejects.toThrow();
    const secret = await archive({ "aro/.env": "SECRET=fixture" });
    await expect(installDesktop(secret, hash(secret), join(root, "secret"))).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
