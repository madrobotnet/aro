import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = process.env.NEXT_DIST_DIR || ".next";
if (!/^\.next(?:-[a-zA-Z0-9-]+)?$/.test(dist)) throw new Error("Invalid build directory");

async function sourceHash() {
  const hash = createHash("sha256");
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) hash.update(path.slice(root.length)).update(await readFile(path));
    }
  }
  await visit(join(root, "src"));
  await visit(join(root, "public"));
  for (const path of ["scripts/desktop.ts", "scripts/desktop-process.ts", "scripts/model.ts", "scripts/model-management.ts", "scripts/build.mjs", "package.json", "bun.lock", "next.config.ts"]) {
    hash.update(path).update(await readFile(join(root, path)));
  }
  return hash.digest("hex");
}

const before = await sourceHash();
const output = join(root, dist, "desktop-launcher");
await rm(join(output, "build-source.json"), { force: true });
const next = Bun.spawn([process.execPath, "--no-env-file", "--bun", "next", "build", "--webpack"],
  { cwd: root, env: process.env, stdout: "inherit", stderr: "inherit" });
const code = await next.exited;
if (code !== 0) process.exit(code);
await mkdir(output, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [join(root, "scripts/desktop.ts"), join(root, "scripts/model.ts")], target: "bun", external: ["argon2"],
  outdir: output, naming: "[name].js",
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Desktop launcher build failed");
await rm(join(root, dist, "desktop-public"), { recursive: true, force: true });
await cp(join(root, "public"), join(root, dist, "desktop-public"), { recursive: true });
if (await sourceHash() !== before) throw new Error("Source changed during build; rebuild before packaging");
await writeFile(join(output, "build-source.json"), JSON.stringify({
  sourceHash: before, distDirectory: dist,
  buildId: (await readFile(join(root, dist, "BUILD_ID"), "utf8")).trim(),
  launcherSha256: createHash("sha256").update(await readFile(join(output, "desktop.js"))).digest("hex"),
  modelSha256: createHash("sha256").update(await readFile(join(output, "model.js"))).digest("hex"),
  version: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
}) + "\n");
