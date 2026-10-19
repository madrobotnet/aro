import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const mode of ["sqlite", "postgres"] as const) test(`OAuth owner routes use real sessions and CSRF (${mode})`, async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file",
    "--preload", Bun.resolveSync("next/dist/server/node-environment-baseline.js", import.meta.dir),
    fileURLToPath(new URL("./route-fixture.js", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, ARO_DATABASE_MODE: mode }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ mode, consent: true, csrf: true, settings: true });
});
