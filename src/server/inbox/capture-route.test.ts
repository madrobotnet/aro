import { expect, test } from "bun:test";

test("real capture route enforces owner confirmation expiry and committed replay", async () => {
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file",
    new URL("./capture-route-fixture.js", import.meta.url).pathname],
  { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect({ exitCode, stderr, stdout }).toMatchObject({ exitCode: 0, stderr: "" });
}, 10_000);
