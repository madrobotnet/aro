import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MODEL, downloadVerified, launchModel, modelDirectory, modelLock, readModelConfig, removeModel,
  runtimeDigest, startConfiguredModel, writeModelConfig,
} from "./model-management";
import { initializeDesktop } from "./desktop";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const data = await mkdtemp(join(tmpdir(), "aro-model-"));
  directories.push(data);
  return { data, directory: await modelDirectory(data) };
}
const bytes = new TextEncoder().encode("bounded fixture weights");
const artifact = { ...MODEL, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
async function transfer(directory: string, body: Uint8Array = bytes, signal?: AbortSignal) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(Buffer.from(body)); } });
  try {
    await downloadVerified(directory, artifact, (_url, options) => fetch(server.url, options), signal);
  } finally { await server.stop(true); }
}
async function executable(data: string, mode = "ready") {
  const path = join(data, `${mode}-runtime`);
  await writeFile(path, `#!${process.execPath}\n${await readFile(join(import.meta.dir, "model-runtime-fixture.mjs"), "utf8")}`, { mode: 0o700 });
  return { version: 1, enabled: true, runtime: path, runtimeSha256: await runtimeDigest(path) } as const;
}
async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(); } });
  const port = server.port;
  await server.stop(true);
  if (!port) throw new Error("Fixture has no port");
  return port;
}

test("publishes only verified streamed bytes with private permissions", async () => {
  const { directory } = await fixture();
  await transfer(directory);
  expect(await readFile(join(directory, MODEL.filename))).toEqual(Buffer.from(bytes));
  expect((await lstat(join(directory, MODEL.filename))).mode & 0o077).toBe(0);
  expect(await readdir(directory)).not.toContain(".weights.part");
});

test("checksum mismatch never publishes a final model", async () => {
  const { directory } = await fixture();
  await expect(transfer(directory, new Uint8Array(bytes.length))).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});

test("oversized HTTP body stops before publication", async () => {
  const { directory } = await fixture();
  await expect(transfer(directory, new Uint8Array(bytes.length + 1))).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});

test("interrupted HTTP stream leaves no corrupt final and retry succeeds", async () => {
  const { directory } = await fixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(bytes.subarray(0, 4), { headers: { "content-length": String(bytes.length) } });
  } });
  try {
    await expect(downloadVerified(directory, artifact, (_url, options) => fetch(server.url, options))).rejects.toThrow();
  } finally { await server.stop(true); }
  expect(await readdir(directory)).not.toContain(MODEL.filename);
  expect(await readdir(directory)).not.toContain(".weights.part");
  await transfer(directory);
  expect(await readFile(join(directory, MODEL.filename))).toEqual(Buffer.from(bytes));
});

test("aborted transfer never publishes and discards stale partial on retry", async () => {
  const { directory } = await fixture();
  const signal = AbortSignal.abort();
  await expect(transfer(directory, bytes, signal)).rejects.toThrow();
  await writeFile(join(directory, ".weights.part"), "interrupted", { mode: 0o600 });
  await transfer(directory);
  expect(await readFile(join(directory, MODEL.filename))).toEqual(Buffer.from(bytes));
});

test("existing final model is never overwritten even when invalid", async () => {
  const { directory } = await fixture();
  await writeFile(join(directory, MODEL.filename), "do not replace", { mode: 0o600 });
  await expect(transfer(directory)).rejects.toThrow();
  expect(await readFile(join(directory, MODEL.filename), "utf8")).toBe("do not replace");
});

test("control lock recovers publication interrupted before partial unlink", async () => {
  const { directory } = await fixture();
  await writeFile(join(directory, ".weights.part"), bytes, { mode: 0o600 });
  await link(join(directory, ".weights.part"), join(directory, MODEL.filename));
  const release = await modelLock(directory);
  try {
    expect((await lstat(join(directory, MODEL.filename))).nlink).toBe(1);
    expect(await readdir(directory)).not.toContain(".weights.part");
    expect(await readFile(join(directory, MODEL.filename))).toEqual(Buffer.from(bytes));
    await expect(transfer(directory)).rejects.toThrow();
  } finally { release(); }
});

test("unrelated hard links are refused rather than unlinked", async () => {
  const { data, directory } = await fixture();
  const target = join(data, "precious");
  await writeFile(target, "keep", { mode: 0o600 });
  await link(target, join(directory, ".weights.part"));
  const release = await modelLock(directory);
  try {
    await expect(transfer(directory)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("keep");
    expect((await lstat(target)).nlink).toBe(2);
  } finally { release(); }
});

test("racing final publication refuses overwrite atomically", async () => {
  const { directory } = await fixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(bytes); } });
  try {
    await expect(downloadVerified(directory, artifact, async (_url, options) => {
      await writeFile(join(directory, MODEL.filename), "winner", { mode: 0o600 });
      return fetch(server.url, options);
    })).rejects.toThrow();
  } finally { await server.stop(true); }
  expect(await readFile(join(directory, MODEL.filename), "utf8")).toBe("winner");
});

test("unsafe redirect is rejected before following external endpoint", async () => {
  const { directory } = await fixture();
  let calls = 0;
  await expect(downloadVerified(directory, artifact, async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/model" } });
  })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("private directories reject shared permissions and symlink ancestors", async () => {
  const { data } = await fixture();
  await chmod(data, 0o755);
  await expect(modelDirectory(data)).rejects.toThrow();
  await chmod(data, 0o700);
  const parent = await mkdtemp(join(tmpdir(), "aro-model-link-"));
  directories.push(parent);
  await symlink(data, join(parent, "alias"));
  await expect(modelDirectory(join(parent, "alias"))).rejects.toThrow();
  await expect(modelDirectory("relative")).rejects.toThrow();
});

test("symlink partial and config cannot read or overwrite their target", async () => {
  const { data, directory } = await fixture();
  const target = join(data, "precious");
  await writeFile(target, "keep", { mode: 0o600 });
  await symlink(target, join(directory, ".weights.part"));
  await symlink(target, join(directory, "config.json"));
  await expect(transfer(directory)).rejects.toThrow();
  await expect(readModelConfig(directory)).rejects.toThrow();
  await expect(removeModel(directory)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("keep");
});

test("strict config rejects args env endpoints and nonprivate files", async () => {
  const { data, directory } = await fixture();
  const config = await executable(data);
  const path = join(directory, "config.json");
  for (const extra of [{ args: ["--host", "0.0.0.0"] }, { env: { KEY: "secret" } }, { baseURL: "https://external.invalid" }]) {
    await writeFile(path, JSON.stringify({ ...config, ...extra }), { mode: 0o600 });
    await expect(readModelConfig(directory)).rejects.toThrow();
  }
  await chmod(path, 0o644);
  await expect(readModelConfig(directory)).rejects.toThrow();
});

test("disabled and absent configuration perform no inference work", async () => {
  const { data, directory } = await fixture();
  expect(await startConfiguredModel(data)).toBeUndefined();
  await writeModelConfig(directory, { version: 1, enabled: false, runtime: "/missing/runtime", runtimeSha256: "0".repeat(64) });
  expect(await startConfiguredModel(data)).toBeUndefined();
});

test("enabled model with missing or invalid weights fails before spawning", async () => {
  const { data, directory } = await fixture();
  await writeModelConfig(directory, await executable(data));
  await expect(startConfiguredModel(data)).rejects.toThrow();
  await writeFile(join(directory, MODEL.filename), "invalid", { mode: 0o600 });
  await expect(startConfiguredModel(data)).rejects.toThrow();
  const release = await modelLock(directory);
  release();
});

test("runtime path must be canonical and not writable by other users", async () => {
  const { data } = await fixture();
  const config = await executable(data);
  await chmod(config.runtime, 0o777);
  await expect(runtimeDigest(config.runtime)).rejects.toThrow();
  await chmod(config.runtime, 0o700);
  await symlink(config.runtime, join(data, "alias"));
  await expect(runtimeDigest(join(data, "alias"))).rejects.toThrow();
});

test("actual child receives fixed loopback flags and sanitized environment then exits cleanly", async () => {
  const { data, directory } = await fixture();
  const config = await executable(data);
  const runtime = await launchModel(directory, config, await freePort(), 3000);
  try {
    const info: { args: string[]; env: Record<string, string> } = await (await fetch(`${runtime.baseURL}/inspect`)).json();
    expect(info.args).toEqual(["-m", join(directory, MODEL.filename), "--embeddings", "--pooling", "mean",
      "--flash-attn", "on", "-t", "2", "-tb", "2", "-np", "1", "-c", "2048", "-b", "2048",
      "-ub", "1024", "--host", "127.0.0.1", "--port", new URL(runtime.baseURL).port]);
    expect(info.env.HOME).toBeUndefined();
    expect(info.env.EMBEDDING_BASE_URL).toBeUndefined();
    expect(info.env.PATH).toBe("/usr/bin:/bin");
  } finally { await runtime.stop(); }
  expect(await runtime.exited).toBe(0);
  await expect(fetch(`${runtime.baseURL}/health`)).rejects.toThrow();
});

test("runtime checksum change is refused without executing it", async () => {
  const { data, directory } = await fixture();
  const config = await executable(data);
  await writeFile(config.runtime, "#!/missing\n");
  await expect(launchModel(directory, config, await freePort())).rejects.toThrow();
});

test("runtime premature exit fails promptly", async () => {
  const { data, directory } = await fixture();
  await expect(launchModel(directory, await executable(data, "fail"), await freePort(), 3000)).rejects.toThrow();
});

test("bounded failed readiness terminates its actual child", async () => {
  const { data, directory } = await fixture();
  const port = await freePort();
  await expect(launchModel(directory, await executable(data, "stall"), port, 150)).rejects.toThrow();
  await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
});

test("startup cancellation follows actual child health event and cleans the process", async () => {
  const { data, directory } = await fixture();
  const controller = new AbortController();
  const notification = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    controller.abort();
    return new Response();
  } });
  const port = await freePort();
  try {
    const config = await executable(data, `cancel-${notification.port}`);
    await expect(launchModel(directory, config, port, 3000, 2000, controller.signal)).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  } finally { await notification.stop(true); }
});

test("owned stubborn process is killed after bounded graceful termination", async () => {
  const { data, directory } = await fixture();
  const runtime = await launchModel(directory, await executable(data, "stubborn"), await freePort(), 3000, 50);
  await runtime.stop();
  expect(await runtime.exited).not.toBe(0);
  await runtime.stop(); // Cleanup is idempotent.
  await expect(fetch(`${runtime.baseURL}/health`)).rejects.toThrow();
});

test("occupied loopback port never attaches to an unrelated service", async () => {
  const { data, directory } = await fixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("ok"); } });
  try {
    const port = server.port;
    if (!port) throw new Error("Missing test port");
    await expect(launchModel(directory, await executable(data), port)).rejects.toThrow();
    expect((await fetch(server.url)).status).toBe(200);
  } finally { await server.stop(true); }
});

test("crashed manager releases OS lock for safe interrupted retry", async () => {
  const { directory } = await fixture();
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "model-lock-fixture.ts"), directory],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(value).trim()).toBe("LOCKED");
    await expect(modelLock(directory)).rejects.toThrow();
    child.kill("SIGKILL");
    await child.exited;
    const release = await modelLock(directory);
    release();
  } finally { child.kill("SIGKILL"); await child.exited; }
});

test("CLI refuses download without explicit consent before making a model directory", async () => {
  const { data } = await fixture();
  const target = join(data, "uncreated");
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "model.ts"),
    "download", "--data-dir", target], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(1);
  expect(await readdir(data)).not.toContain("uncreated");
});

test("CLI status disable and remove preserve unrelated files and operator executable", async () => {
  const { data, directory } = await fixture();
  const config = await executable(data);
  await writeModelConfig(directory, config);
  await writeFile(join(directory, MODEL.filename), "test weights", { mode: 0o600 });
  await writeFile(join(directory, "unrelated"), "keep", { mode: 0o600 });
  for (const command of ["status", "disable", "remove"]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "model.ts"), command, "--data-dir", data],
      { stdout: "pipe", stderr: "pipe" });
    const result = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    if (command === "status") expect(result).toMatchObject({ enabled: true, weights: "invalid", inUse: false });
    if (command === "disable") expect((await readModelConfig(directory))?.enabled).toBe(false);
  }
  expect(await readdir(directory)).not.toContain(MODEL.filename);
  expect(await readdir(directory)).not.toContain("config.json");
  expect(await readFile(join(directory, "unrelated"), "utf8")).toBe("keep");
  expect((await lstat(config.runtime)).isFile()).toBe(true);
});

test("bundled model CLI runs isolated without application web handlers or dependencies", async () => {
  const { data } = await fixture();
  const output = join(data, "bundle");
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "model.ts")],
    target: "bun", outdir: output, naming: "model.js" });
  expect(bundle.success).toBe(true);
  const child = Bun.spawn([process.execPath, "--no-env-file", join(output, "model.js"), "status", "--data-dir", data],
    { cwd: output, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
  const result = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(result).toMatchObject({ enabled: false, inUse: false });
});

test("actual desktop launcher strips external endpoint and runs app after optional model failure", async () => {
  const { data, directory } = await fixture();
  await initializeDesktop(data, "a-private-test-password");
  await writeModelConfig(directory, { version: 1, enabled: true, runtime: "/missing/runtime", runtimeSha256: "0".repeat(64) });
  const packageRoot = join(data, "package");
  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await mkdir(join(packageRoot, ".next"));
  await writeFile(join(packageRoot, ".next", "BUILD_ID"), "fixture");
  await writeFile(join(packageRoot, "server.js"),
    'console.log(JSON.stringify({embedding:process.env.EMBEDDING_BASE_URL??null,host:process.env.HOSTNAME,mode:process.env.ARO_DATABASE_MODE}));');
  await symlink(join(import.meta.dir, "..", "node_modules"), join(packageRoot, "node_modules"));
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "desktop.ts")],
    target: "bun", external: ["argon2"], outdir: join(packageRoot, "scripts"), naming: "desktop.js" });
  expect(bundle.success).toBe(true);
  const child = Bun.spawn([process.execPath, "--no-env-file", join(packageRoot, "scripts", "desktop.js"),
    "start", "--data-dir", data], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin",
      EMBEDDING_BASE_URL: "https://untrusted.invalid" },
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(result).toEqual({ embedding: null, host: "127.0.0.1", mode: "sqlite" });
  const release = await modelLock(directory);
  release();
});
