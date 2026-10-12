import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ChatProviderError, type ChatProvider, type ProviderInput } from "./provider";
import { cliInstructions } from "@/server/i18n/copy";
import {
  cliCredentialFile, cliSearchPath, collectCliCredential, findCliBinary, stageCliCredential,
  type CliAuthProvider, type CliEnvironment, type CliStoredSession,
} from "./cli-auth";

export type CliProviderOptions = {
  readonly env?: CliEnvironment;
  readonly session?: CliStoredSession;
  readonly timeoutMs?: number;
  /** Lower limits may be supplied by deterministic subprocess tests. */
  readonly maxOutputBytes?: number;
  readonly maxStderrBytes?: number;
  /** Test-only: run a fixture script through a runtime instead of the fixed CLI. */
  readonly fixtureCommand?: { readonly runtime: string; readonly script: string };
};

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("init"), session_id: z.string(), model: z.string() }),
  z.object({ type: z.literal("message"), role: z.enum(["user", "assistant"]), content: z.string(), delta: z.boolean().optional() }),
  z.object({ type: z.literal("result"), status: z.enum(["success", "error"]), error: z.unknown().optional() }),
  z.object({ type: z.literal("error") }),
  z.object({ type: z.literal("tool_use") }),
  z.object({ type: z.literal("tool_result") }),
]);

// Pinned source: https://github.com/google-gemini/gemini-cli/tree/v0.61.0
// packages/cli/src/config/settingsSchema.ts and config.ts pass tools.core [] to
// core/config/config.ts: maybeRegister() tests .some(), NOT .length, so no builtin
// tools are registered. Admin gates prevent extension loading and MCP startup.
// --policy replaces user policies. A global "*" deny also removes tool schemas.
// No sandbox launcher: it would copy stdin into argv when relaunching.
const settings = {
  tools: { core: [] },
  hooksConfig: { enabled: false },
  admin: { mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } },
  skills: { enabled: false },
  experimental: { enableAgents: false, autoMemory: false, gemma: false, extensionManagement: false },
  general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
  context: { fileName: "disabled-context", includeDirectoryTree: false, fileFiltering: { enableFileWatcher: false } },
  security: { auth: { selectedType: "oauth-personal", enforcedType: "oauth-personal" } },
  telemetry: { enabled: false },
  privacy: { usageStatisticsEnabled: false },
  advanced: { ignoreLocalEnv: true },
} as const;

const policy = '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n';
const maxInputBytes = 1024 * 1024;
const maxLineBytes = 1024 * 1024;

function inputText(input: ProviderInput): string {
  // JSON framing prevents slash commands; escaping @ prevents Gemini's
  // nonInteractiveCli -> handleAtCommand from reading files BEFORE model/tools.
  return JSON.stringify({
    instructions: cliInstructions(input.locale ?? "ko"),
    question: input.question,
    history: input.history,
    sources: input.sources,
  }).replaceAll("@", "\\u0040");
}

function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new ChatProviderError();
  return value;
}

/**
 * Linux process groups are required. This Auth adapter runs only Gemini CLI;
 * Claude is supported through its API adapter, not a subscription-token bridge.
 */
export function createCliProvider(
  input: { readonly provider: CliAuthProvider; readonly model: string },
  options: CliProviderOptions = {},
): ChatProvider {
  if (process.platform !== "linux" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(input.model)) {
    throw new ChatProviderError();
  }
  const timeoutMs = limit(options.timeoutMs, 120_000);
  const maxOutputBytes = limit(options.maxOutputBytes, 4 * 1024 * 1024);
  const maxStderrBytes = limit(options.maxStderrBytes, 64 * 1024);
  const env = options.env ?? process.env;

  return {
    async stream(request, onDelta, signal) {
      let root: string | undefined;
      let stagedCredential: string | undefined;
      try {
        if (signal.aborted) throw new ChatProviderError();
        const text = inputText(request);
        if (Buffer.byteLength(text) > maxInputBytes) throw new ChatProviderError();
        const credential = options.session ? undefined : await cliCredentialFile(env);
        const binary = options.fixtureCommand?.runtime ?? await findCliBinary(env);
        if ((!options.session && !credential) || !binary) throw new ChatProviderError();

        // Fixed /tmp rather than app-controlled TMPDIR; each run has an empty cwd
        // and a private HOME so CLI startup cannot discover repository/user config.
        root = await mkdtemp("/tmp/aro-cli-");
        const cwd = path.join(root, "work");
        const home = path.join(root, "home");
        const config = path.join(home, ".gemini");
        await mkdir(cwd);
        await mkdir(config, { recursive: true });
        const authFile = path.join(config, "oauth_creds.json");
        if (options.session) {
          await stageCliCredential(authFile, options.session.credential);
          stagedCredential = authFile;
        } else if (credential) {
          // Preserve legacy write-through refresh to the explicitly injected root.
          await symlink(credential, authFile);
        }
        const settingsPath = path.join(root, "settings.json");
        const policyPath = path.join(root, "deny.toml");
        await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
        await writeFile(policyPath, policy, { mode: 0o600 });
        const childEnv = {
          HOME: home,
          PATH: cliSearchPath(env),
          NODE_ENV: "production" as const,
          LANG: "C.UTF-8",
          // oauth2.ts rejects expired/missing login in noninteractive mode
          // rather than opening a browser or entering manual authorization.
          NO_BROWSER: "true",
          GEMINI_CLI_HOME: home,
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
          GEMINI_CLI_SYSTEM_DEFAULTS_PATH: settingsPath,
        };
        const args = [
          "--output-format", "stream-json", "--approval-mode", "default",
          "--extensions", "none", "--policy", policyPath, "--model", input.model,
        ];
        if (options.fixtureCommand) args.unshift(options.fixtureCommand.script);
        if (signal.aborted) throw new ChatProviderError();

        return await new Promise<string>((resolve, reject) => {
          const child = spawn(binary, args, { cwd, env: childEnv, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
          let failed = false;
          let initialized = false;
          let terminal = false;
          let output = "";
          let buffer = "";
          let stdoutBytes = 0;
          let stderrBytes = 0;
          const decoder = new TextDecoder("utf-8", { fatal: true });

          const killTree = (): void => {
            if (child.pid === undefined) return;
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
                failed = true;
              }
            }
          };
          const fail = (): void => {
            failed = true;
            killTree();
          };
          const timer = setTimeout(fail, timeoutMs);
          const abort = (): void => fail();
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) fail();

          const consume = (line: string): void => {
            if (!line.trim()) return;
            if (terminal) throw new ChatProviderError();
            const event = eventSchema.parse(JSON.parse(line));
            if (!initialized && event.type !== "init") throw new ChatProviderError();
            switch (event.type) {
              case "init":
                if (initialized) throw new ChatProviderError();
                initialized = true;
                break;
              case "message":
                if (event.role === "assistant") {
                  if (event.delta !== true) throw new ChatProviderError();
                  output += event.content;
                  onDelta(event.content);
                }
                break;
              case "result":
                if (event.status !== "success" || event.error !== undefined) throw new ChatProviderError();
                terminal = true;
                break;
              case "error":
              case "tool_use":
              case "tool_result":
                throw new ChatProviderError();
            }
          };
          child.stdout.on("data", (chunk: Buffer) => {
            if (failed) return;
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxOutputBytes) return fail();
            try {
              buffer += decoder.decode(chunk, { stream: true });
              let boundary = buffer.indexOf("\n");
              while (boundary >= 0 && !failed) {
                const line = buffer.slice(0, boundary);
                if (Buffer.byteLength(line) > maxLineBytes) throw new ChatProviderError();
                buffer = buffer.slice(boundary + 1);
                consume(line);
                boundary = buffer.indexOf("\n");
              }
              if (Buffer.byteLength(buffer) > maxLineBytes) fail();
            } catch { // no-excuse-ok: catch -- untrusted subprocess/browser boundary
              // Protocol, callback and decoder errors cross the browser boundary
              // as the same generic error; never expose event bodies or stderr.
              fail();
            }
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > maxStderrBytes) fail();
          });
          child.stdin.on("error", fail);
          child.stdout.on("error", fail);
          child.stderr.on("error", fail);
          child.on("error", fail);
          // Kill lingering descendants even if their leader exited successfully.
          child.once("exit", killTree);
          child.once("close", (code, exitSignal) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            try {
              buffer += decoder.decode();
              // Require newline termination; a truncated final record is not success.
              if (buffer.trim() || failed || signal.aborted || code !== 0 || exitSignal || !terminal || !output.trim()) {
                reject(new ChatProviderError());
              } else {
                resolve(output);
              }
            } catch { // no-excuse-ok: catch -- never expose decoder input
              reject(new ChatProviderError());
            }
          });
          child.stdin.end(text);
        });
      } catch (error) {
        if (error instanceof ChatProviderError) throw error;
        throw new ChatProviderError();
      } finally {
        try {
          // Token refresh can succeed even when generation is cancelled or fails.
          if (stagedCredential && options.session) await collectCliCredential(stagedCredential, options.session);
        } catch (error) {
          if (error instanceof Error) throw new ChatProviderError();
          throw error;
        } finally {
          if (root) await rm(root, { recursive: true, force: true }).catch(() => { throw new ChatProviderError(); });
        }
      }
    },
  };
}
