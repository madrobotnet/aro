import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

async function run(values) {
  const child = Bun.spawn([process.execPath, "--no-env-file",
    fileURLToPath(new URL("./build-database-url.mjs", import.meta.url))], {
    env: { PATH: process.env.PATH, ...values }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test.each(["aro", "second_brain"])("database URL uses explicitly configured %s names", async name => {
  const result = await run({ POSTGRES_APP_DB: name, POSTGRES_APP_USER: name, POSTGRES_APP_PASSWORD: "fixture#@" });
  expect(result).toEqual({ code: 0, stdout: `postgres://${name}:fixture%23%40@db:5432/${name}`, stderr: "" });
});

test.each(["POSTGRES_APP_DB", "POSTGRES_APP_USER", "POSTGRES_APP_PASSWORD"])("missing %s fails without exposing credentials", async missing => {
  const values = { POSTGRES_APP_DB: "aro", POSTGRES_APP_USER: "aro", POSTGRES_APP_PASSWORD: "fixture-private" };
  delete values[missing];
  const result = await run(values);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("fixture-private");
});
