import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("real capture route enforces owner confirmation expiry and committed replay", async () => {
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file",
    "--preload", Bun.resolveSync("next/dist/server/node-environment-baseline.js", import.meta.dir),
    fileURLToPath(new URL("./capture-route-fixture.js", import.meta.url))],
  { cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect({ exitCode, stderr, stdout }).toMatchObject({ exitCode: 0, stderr: "" });
}, 10_000);
