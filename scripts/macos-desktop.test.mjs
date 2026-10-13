import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopDirectory } from "./desktop";
import { packageDesktop } from "./package-desktop.mjs";
import { updateDesktop } from "./update-desktop.mjs";

test.skipIf(process.platform !== "darwin")("macOS distribution refuses before writing package or update paths", async () => {
  // Given
  const root = await mkdtemp(join(await realpath(tmpdir()), "aro-macos-distribution-"));
  try {
    // When
    const packaging = packageDesktop(join(root, "package"));
    const updating = updateDesktop({ directory: join(root, "update") });
    // Then
    await expect(packaging).rejects.toMatchObject({ code: "macos-desktop-distribution-unsupported" });
    await expect(updating).rejects.toMatchObject({ code: "macos-desktop-distribution-unsupported" });
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "darwin")("macOS canonical temporary paths pass while redirected ancestor aliases fail", async () => {
  // Given
  const root = await mkdtemp(join(await realpath(tmpdir()), "aro-macos-path-"));
  const data = join(root, "data"), alias = join(root, "alias");
  await mkdir(data, { mode: 0o700 });
  await symlink(root, alias);
  try {
    // When / Then: the legitimate canonical path is accepted; no redirect is trusted.
    expect(await desktopDirectory(data)).toBe(data);
    await expect(desktopDirectory(join(alias, "data"))).rejects.toThrow();
    const redirected = join(tmpdir(), root.split("/").at(-1), "data");
    if (redirected !== data) await expect(desktopDirectory(redirected)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
