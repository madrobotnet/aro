#!/usr/bin/env bun
import { join } from "node:path";
import {
  MODEL, ModelBusyError, ModelError, downloadVerified, fileDigest, modelDirectory, modelLock, readModelConfig,
  removeModel, runtimeDigest, startConfiguredModel, verifyModel, writeModelConfig,
} from "./model-management";

async function main(): Promise<void> {
  process.umask(0o077);
  const [command, ...args] = process.argv.slice(2);
  let dataDirectory: string | undefined;
  let runtime: string | undefined;
  let consent = false;
  let trust = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg || seen.has(arg)) throw new ModelError("Invalid/repeated model option");
    seen.add(arg);
    switch (arg) {
      case "--data-dir": dataDirectory = args[++i]; break;
      case "--runtime": runtime = args[++i]; break;
      case "--consent-download": consent = true; break;
      case "--trust-runtime": trust = true; break;
      default: throw new ModelError("Unknown model option");
    }
  }
  if (!dataDirectory || !["download", "configure", "start", "status", "disable", "remove"].includes(command ?? "")) {
    throw new ModelError("Usage: bun --no-env-file scripts/model.ts download|configure|start|status|disable|remove --data-dir ABSOLUTE (download: --consent-download; configure: --runtime ABSOLUTE --trust-runtime)");
  }
  if ((consent && command !== "download") || ((runtime || trust) && command !== "configure")) throw new ModelError("Option does not apply to this command");
  if (command === "download" && !consent) throw new ModelError(`Review upstream terms and explicitly pass --consent-download to fetch ${MODEL.bytes} bytes from ${MODEL.url}. This does not accept third-party terms.`);
  if (command === "configure" && (!runtime || !trust)) throw new ModelError("Supply an operator-trusted native llama-server with --runtime ABSOLUTE --trust-runtime; no runtime is downloaded or licensed here");
  const directory = await modelDirectory(dataDirectory);
  if (command === "start") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let model: Awaited<ReturnType<typeof startConfiguredModel>>;
    try {
      model = await startConfiguredModel(dataDirectory, controller.signal);
      if (!model) throw new ModelError("Model is not configured/enabled");
      console.log(JSON.stringify({ state: "ready", baseURL: model.baseURL }));
      if (!controller.signal.aborted) {
        const result = await Promise.race([
          model.exited,
          new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true })),
        ]);
        if (typeof result === "number") process.exitCode = result;
      }
    } finally {
      await model?.stop();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }
  if (command === "status") {
    const config = await readModelConfig(directory);
    let inUse = false;
    try { const unlock = await modelLock(directory); unlock(); }
    catch (error) { if (!(error instanceof ModelBusyError)) throw error; inUse = true; }
    let weights = "missing";
    try {
      const actual = await fileDigest(join(directory, MODEL.filename), MODEL.bytes);
      weights = actual.bytes === MODEL.bytes && actual.sha256 === MODEL.sha256 ? "verified" : "invalid";
    } catch (error) { if (!(error instanceof ModelError)) throw error; weights = "missing-or-invalid"; }
    console.log(JSON.stringify({ enabled: config?.enabled ?? false, weights, inUse, runtime: config?.runtime ?? null }));
    return;
  }
  const unlock = await modelLock(directory);
  try {
    switch (command) {
      case "download": await downloadVerified(directory); break;
      case "configure":
        if (!runtime) throw new ModelError("Runtime is required");
        await verifyModel(directory);
        await writeModelConfig(directory, { version: 1, enabled: true, runtime, runtimeSha256: await runtimeDigest(runtime) });
        break;
      case "disable": {
        const config = await readModelConfig(directory);
        if (config) await writeModelConfig(directory, { ...config, enabled: false });
        break;
      }
      case "remove": await removeModel(directory); break;
      default: throw new ModelError("Unsupported model command");
    }
    console.log(JSON.stringify({ completed: command }));
  } finally { unlock(); }
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Model management failed");
  process.exitCode = 1;
});
