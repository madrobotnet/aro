import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("protects sharing routes with real owner sessions and CSRF checks", async () => {
  // Given isolated Next request stores and a real file-backed database.
  const child = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file",
    "--preload", Bun.resolveSync("next/dist/server/node-environment-baseline.js", import.meta.dir),
    fileURLToPath(new URL("./route-fixture.js", import.meta.url))],
    { cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
  // When the endpoint scenario completes.
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  // Then cookie auth, CSRF and read-only capability checks pass.
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0, stderr: "" });
}, 10_000);
