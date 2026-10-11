import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "node:net";
import { z } from "zod";

export const MODEL = {
  filename: "embeddinggemma-2-Q8_0.gguf",
  url: "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8/embeddinggemma-2-Q8_0.gguf",
  bytes: 309855456,
  sha256: "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135",
} as const;
export const MODEL_PORT = 18080;
const CONFIG = "config.json";
const configSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  runtime: z.string().min(1).max(4096).refine(isAbsolute),
  runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ModelConfig = z.infer<typeof configSchema>;

export class ModelError extends Error {}
export class ModelBusyError extends ModelError {}
const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Linux only; reject symlinks in the full path, shared directories and foreign owners. */
export async function modelDirectory(dataDirectory: string): Promise<string> {
  if (process.platform !== "linux") throw new ModelError("Local model management is verified only on Linux");
  if (!isAbsolute(dataDirectory)) throw new ModelError("Use an absolute data directory");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  for (const directory of [dataDirectory, join(dataDirectory, "models")]) {
    if (directory !== dataDirectory) await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory ||
        info.uid !== process.getuid?.() || (info.mode & 0o077)) {
      throw new ModelError("Model directories must be private, user-owned, canonical and symlink-free");
    }
  }
  return join(dataDirectory, "models");
}

async function privateFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        info.uid !== process.getuid?.() || (info.mode & 0o077)) {
      throw new ModelError(`Unsafe private model file: ${path}`);
    }
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Recover a crash between no-overwrite link publication and partial unlink. */
async function recoverPublication(directory: string): Promise<void> {
  const final = join(directory, MODEL.filename);
  const part = join(directory, ".weights.part");
  const info = await Promise.all([final, part].map(async path => {
    try { return await lstat(path); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }));
  const [published, partial] = info;
  if (published && partial && published.isFile() && partial.isFile() &&
      published.ino === partial.ino && published.dev === partial.dev && published.nlink === 2 &&
      published.uid === process.getuid?.() && !(published.mode & 0o077)) {
    await unlink(part);
  }
}

/** Separate control lock, never the app database. OS releases it after interruption. */
export async function modelLock(directory: string): Promise<() => void> {
  const path = join(directory, "management.lock.sqlite");
  if (!await privateFile(path)) {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      .catch(error => {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined;
        throw error;
      });
    await file?.close();
    await privateFile(path);
  }
  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout=0");
    db.run("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    throw new ModelBusyError(`Model workflow busy; stop its owning launcher/start command first (${error instanceof Error ? error.message : "lock failed"})`);
  }
  try { await recoverPublication(directory); }
  catch (error) { db.run("ROLLBACK"); db.close(); throw error; }
  return () => { db.run("ROLLBACK"); db.close(); };
}

export async function readModelConfig(directory: string): Promise<ModelConfig | undefined> {
  const path = join(directory, CONFIG);
  if (!await privateFile(path)) return undefined;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await file.stat()).size > 8192) throw new ModelError("Model config is too large");
    return configSchema.parse(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
}

export async function writeModelConfig(directory: string, config: ModelConfig): Promise<void> {
  await privateFile(join(directory, CONFIG));
  const temp = join(directory, ".config.part");
  if (await privateFile(temp)) await unlink(temp);
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(JSON.stringify(configSchema.parse(config)) + "\n");
    await file.sync();
  } finally { await file.close(); }
  await rename(temp, join(directory, CONFIG));
}

export async function fileDigest(path: string, maxBytes: number, privateOnly = true): Promise<{ bytes: number; sha256: string }> {
  if (privateOnly && !await privateFile(path)) throw new ModelError("Model weights are missing; run download with explicit consent");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new ModelError("File exceeds the allowed size");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const result = await file.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > maxBytes) throw new ModelError("File exceeds the allowed size");
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally { await file.close(); }
}

export async function verifyModel(directory: string): Promise<void> {
  const actual = await fileDigest(join(directory, MODEL.filename), MODEL.bytes);
  if (actual.bytes !== MODEL.bytes || actual.sha256 !== MODEL.sha256) throw new ModelError("Pinned model checksum/size mismatch");
}

function trustedURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !["huggingface.co", "cas-bridge.xethub.hf.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co"].includes(url.hostname)) {
    throw new ModelError("Download requires a pinned trusted HTTPS host");
  }
  return url;
}

/** Caller holds modelLock. Transport seam is for local HTTP tests, not CLI configuration. */
export async function downloadVerified(
  directory: string,
  artifact: Readonly<{ filename: string; url: string; bytes: number; sha256: string }> = MODEL,
  transport: (url: string, options: RequestInit) => Promise<Response> = fetch,
  signal: AbortSignal = AbortSignal.timeout(10 * 60 * 1000),
): Promise<void> {
  if (artifact.filename !== MODEL.filename) throw new ModelError("Unsupported model filename");
  const final = join(directory, artifact.filename);
  if (await privateFile(final)) throw new ModelError("Model already exists; remove explicitly before downloading");
  const part = join(directory, ".weights.part");
  // A previous interrupted transfer is discarded under the recovered OS lock, never resumed blindly.
  if (await privateFile(part)) await unlink(part);
  let url = trustedURL(artifact.url);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await transport(url.href, { redirect: "manual", signal, headers: { "Accept-Encoding": "identity" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new ModelError("Invalid or excessive model redirect");
    url = trustedURL(new URL(location, url).href);
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel();
    throw new ModelError("Model download refused/unavailable; review upstream access and terms yourself");
  }
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) !== artifact.bytes) {
    await response.body.cancel();
    throw new ModelError("Model download size mismatch");
  }
  const file = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const reader = response.body.getReader();
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > artifact.bytes) throw new ModelError("Model download exceeds pinned size");
      hash.update(value);
      let offset = 0;
      while (offset < value.length) {
        const written = await file.write(value, offset, value.length - offset);
        if (!written.bytesWritten) throw new ModelError("Model write made no progress");
        offset += written.bytesWritten;
      }
    }
    if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) throw new ModelError("Pinned model checksum/size mismatch");
    await file.sync();
    await file.close();
    // Hard-link publication is atomic and refuses even a concurrently created final path.
    await link(part, final);
  } finally {
    try { await reader.cancel(); }
    finally {
      reader.releaseLock();
      try { await file.close(); } finally { await unlink(part); }
    }
  }
}

export async function runtimeDigest(path: string): Promise<string> {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new ModelError("Runtime must be an absolute symlink-free executable path");
  const info = await lstat(path);
  if (!info.isFile() || (info.uid !== process.getuid?.() && info.uid !== 0) || (info.mode & 0o022)) {
    throw new ModelError("Runtime must be operator/root-owned and not group/world writable");
  }
  await access(path, constants.X_OK);
  return (await fileDigest(path, 256 * 1024 * 1024, false)).sha256;
}

export type ModelRuntime = {
  readonly baseURL: string;
  readonly exited: Promise<number>;
  readonly stop: () => Promise<void>;
};

/** No shell, operator arguments, inherited secrets or configurable network binding. */
export async function launchModel(
  directory: string, config: ModelConfig, port = MODEL_PORT, readyMs = 30000, stopMs = 2000,
  signal?: AbortSignal,
): Promise<ModelRuntime> {
  signal?.throwIfAborted();
  if (await runtimeDigest(config.runtime) !== config.runtimeSha256) throw new ModelError("Runtime changed since operator configuration");
  // Refuse to mistake an existing local service for the child. This is not an endpoint override.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  });
  const child = Bun.spawn([config.runtime, "-m", join(directory, MODEL.filename), "--embeddings",
    "--pooling", "mean", "--flash-attn", "on", "-t", "2", "-tb", "2", "-np", "1",
    "-c", "2048", "-b", "2048", "-ub", "1024", "--host", "127.0.0.1", "--port", String(port)], {
    env: { LANG: "C", PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), stopMs);
      try { await child.exited; } finally { clearTimeout(timer); }
    })();
    return stopping;
  };
  const controller = new AbortController();
  const abort = () => controller.abort(new ModelError("Model startup cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new ModelError("Model readiness timed out")), readyMs);
  const exit = child.exited.then(() => { controller.abort(new ModelError("Model exited before readiness")); });
  try {
    // llama-server has no stable parent IPC readiness event; bounded health polling is the protocol.
    for (;;) {
      controller.signal.throwIfAborted();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]), redirect: "error",
        });
        await response.body?.cancel();
        if (response.status === 200 && child.exitCode === null) break;
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!(error instanceof Error)) throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(controller.signal.reason); };
        const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 100);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
      });
    }
    return { baseURL: `http://127.0.0.1:${port}`, exited: child.exited, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    // The resolved exit handler only aborts this local readiness controller.
    void exit;
  }
}

/** Launcher boundary: absent/disabled config does no network or process work. */
export async function startConfiguredModel(dataDirectory: string, signal?: AbortSignal): Promise<ModelRuntime | undefined> {
  const directory = await modelDirectory(dataDirectory);
  const config = await readModelConfig(directory);
  if (!config?.enabled) return undefined;
  const unlock = await modelLock(directory);
  try {
    const current = await readModelConfig(directory);
    if (!current?.enabled) { unlock(); return undefined; }
    await verifyModel(directory);
    const runtime = await launchModel(directory, current, MODEL_PORT, 30000, 2000, signal);
    let released = false;
    const release = () => { if (!released) { released = true; unlock(); } };
    void runtime.exited.then(release);
    return { ...runtime, stop: async () => { try { await runtime.stop(); } finally { release(); } } };
  } catch (error) { unlock(); throw error; }
}

export async function removeModel(directory: string): Promise<void> {
  for (const name of [CONFIG, ".config.part", MODEL.filename, ".weights.part"]) {
    if (await privateFile(join(directory, name))) await unlink(join(directory, name));
  }
}
