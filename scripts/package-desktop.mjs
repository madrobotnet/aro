#!/usr/bin/env bun
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

export class WindowsDesktopDistributionError extends Error {
  constructor() {
    super("Windows desktop packaging and updates are unverified and unsupported in this round");
    this.code = "windows-desktop-distribution-unsupported";
  }
}

export class MacOSDesktopDistributionError extends Error {
  constructor() {
    super("macOS desktop packaging and updates are unverified and unsupported");
    this.code = "macos-desktop-distribution-unsupported";
  }
}

/** Produce an unpublished native-runtime directory from a successful standalone build. */
export async function packageDesktop(output, distDirectory = ".next") {
  if (process.platform === "win32") throw new WindowsDesktopDistributionError();
  if (process.platform === "darwin") throw new MacOSDesktopDistributionError();
  if (!/^\.next(?:-[a-zA-Z0-9-]+)?$/.test(distDirectory)) throw new Error("Invalid build directory");
  const destination = resolve(output);
  if (destination === root || destination.startsWith(`${root}/`)) throw new Error("Package output must be outside the checkout");
  const build = join(root, distDirectory);
  await access(join(build, "BUILD_ID"));
  await access(join(build, "standalone", "server.js"));
  const provenance = JSON.parse(await readFile(join(build, "desktop-launcher", "build-source.json"), "utf8"));
  if (provenance.distDirectory !== distDirectory || !/^[a-f0-9]{64}$/.test(provenance.sourceHash)) {
    throw new Error("Missing matching desktop build provenance");
  }
  if (provenance.buildId !== (await readFile(join(build, "BUILD_ID"), "utf8")).trim() ||
      provenance.launcherSha256 !== createHash("sha256").update(await readFile(join(build, "desktop-launcher", "desktop.js"))).digest("hex") ||
      provenance.modelSha256 !== createHash("sha256").update(await readFile(join(build, "desktop-launcher", "model.js"))).digest("hex")) {
    throw new Error("Desktop launcher and server build do not match");
  }
  await mkdir(destination, { mode: 0o700 }); // Refuse existing targets.
  await cp(join(build, "standalone"), destination, { recursive: true, dereference: true,
    filter: source => !source.split("/").some(part => part === ".env" || part.startsWith(".env.") || part === ".data"),
  });
  await cp(join(build, "static"), join(destination, distDirectory, "static"), { recursive: true });
  await cp(join(build, "desktop-public"), join(destination, "public"), { recursive: true });
  await mkdir(join(destination, "scripts"), { recursive: true });
  await cp(join(build, "desktop-launcher", "desktop.js"), join(destination, "scripts", "desktop.js"));
  await cp(join(build, "desktop-launcher", "model.js"), join(destination, "scripts", "model.js"));
  await mkdir(join(destination, "docs"), { recursive: true });
  await cp(join(root, "docs/MODEL-MANAGEMENT.md"), join(destination, "docs/MODEL-MANAGEMENT.md"));
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await cp(join(root, file), join(destination, file));
  }
  await writeFile(join(destination, "desktop-release.json"), JSON.stringify({
    schemaVersion: 1, version: provenance.version, development: true, platform: process.platform,
    arch: process.arch, runtime: `bun-${Bun.version}`, distDirectory,
    entrypoint: "scripts/desktop.js", sourceHash: provenance.sourceHash,
  }, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  return destination;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !args[0] || !args[1]) throw new Error("Usage: bun scripts/package-desktop.mjs OUTPUT_DIRECTORY DIST_DIRECTORY");
  console.log(await packageDesktop(args[0], args[1]));
}
