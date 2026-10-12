import { expect, test } from "bun:test";

test("real auth routes preserve legacy login and replace and clear both cookie names", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file",
    new URL("./cookie-route-fixture.js", import.meta.url).pathname], {
    cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ legacyAccepted: true, newPreferred: true, loginReplaced: true,
    logoutClearedBoth: true, revokeAllClearedBoth: true });
}, 10_000);
