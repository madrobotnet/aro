import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const kind of ["debian", "runtime"]) {
  test.skipIf(process.platform !== "linux")(`${kind} preparation labels its probe and preserves failure cleanup`, async () => {
    // Given a Docker wire fixture, no daemon or real Docker resource is used.
    const root = await mkdtemp(join(tmpdir(), "aro-resource-labels-"));
    const log = join(root, "docker.jsonl");
    const id = `sha256:${"a".repeat(64)}`;
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(join(bin, "docker"), `#!${process.execPath}
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.QA_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "image" && args[1] === "inspect") {
  const image = { Id: ${JSON.stringify(id)}, Os: "linux", Architecture: "arm64", RepoDigests: [], RepoTags: [] };
  console.log(JSON.stringify(args.includes("--format") ? image : [image]));
} else if (args[0] === "run") {
  // Stop before source acquisition, after the actual probe command is observed.
  console.log(JSON.stringify(process.env.QA_KIND === "debian" ? { packages: [] } : { platform: "fixture" }));
} else if (!["rm", "ps"].includes(args[0])) {
  process.exitCode = 1;
}
`, { mode: 0o700 });
      const script = new URL(`../../scripts/prepare-redistribution-${kind}.mjs`, import.meta.url);
      const args = ["--image", "fixture:qa", "--out", join(root, "out")];
      if (kind === "debian") args.push("--expected-index", id);
      else args.push("--architecture", "arm64");

      // When the real preparation script probes the fixture image.
      const child = Bun.spawn([process.execPath, "--no-env-file", script.pathname, ...args], {
        env: { PATH: `${bin}:${process.env.PATH}`, QA_LOG: log, QA_KIND: kind },
        stdout: "pipe", stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([
        child.exited, new Response(child.stderr).text(), new Response(child.stdout).text(),
      ]);

      // Then the Docker boundary carries new labels even on an early failure.
      expect(code).toBe(1);
      expect(stderr).not.toBe("");
      const commands = (await readFile(log, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
      const run = commands.find(args => args[0] === "run");
      expect(run).toBeDefined();
      const labels = run.flatMap((arg, index) => arg === "--label" ? [run[index + 1]] : []);
      expect(labels).toContain("aro.qa.owner=aro-id-release");
      if (kind === "debian") {
        const name = run[run.indexOf("--name") + 1];
        expect(name).toMatch(/^aro-debian-source-[a-f0-9]{8}$/);
        expect(labels).toContain(`org.aro.redistribution.debian=${name}`);
        expect(commands).toContainEqual(["rm", "-f", name]);
        expect(commands).toContainEqual(["ps", "-aq", "--filter", `label=org.aro.redistribution.debian=${name}`]);
      } else {
        expect(labels).toContain("org.aro.runtime-preparation=inspection");
        expect(run).toContain("--rm");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
