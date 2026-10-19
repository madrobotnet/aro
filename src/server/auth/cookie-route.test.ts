import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("real auth routes preserve legacy login and replace and clear both cookie names", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file",
    "--preload", Bun.resolveSync("next/dist/server/node-environment-baseline.js", import.meta.dir),
    fileURLToPath(new URL("./cookie-route-fixture.js", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ legacyAccepted: true, newPreferred: true, loginReplaced: true,
    logoutClearedBoth: true, revokeAllClearedBoth: true });
}, 10_000);
