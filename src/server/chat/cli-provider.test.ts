import { afterEach, expect, test as platformTest } from "bun:test";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { z } from "zod";
import { createCliProvider, type CliProviderOptions } from "./cli-provider";
import { ChatProviderError } from "./provider";
import { cliInstructions } from "@/server/i18n/copy";

// The official CLI adapter requires Linux process groups and private /tmp.
const test = platformTest.skipIf(process.platform !== "linux");

const roots: string[] = [];
const nodeRuntime = Bun.which("node");
if (!nodeRuntime) throw new Error("Node is required for the official-CLI subprocess fixtures");
const fixtureCommand = { runtime: nodeRuntime, script: path.join(import.meta.dir, "cli-provider-fixture.ts") };
const request = { question: "question", history: [], sources: [], locale: "ko" as const };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(model = "success", overrides: CliProviderOptions = {}) {
  const root = await mkdtemp("/tmp/cli-provider-test-");
  roots.push(root);
  await mkdir(path.join(root, ".gemini"));
  const credential = path.join(root, ".gemini/oauth_creds.json");
  await writeFile(credential, "fixture-credential-not-a-live-token");
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    GEMINI_CLI_HOME: root,
    CLAUDE_CONFIG_DIR: "/unrelated/claude",
    DATABASE_URL: "SECRET-db",
    SETUP_TOKEN: "SECRET-setup",
    ANTHROPIC_API_KEY: "SECRET-anthropic",
    GOOGLE_API_KEY: "SECRET-google",
    GEMINI_API_KEY: "SECRET-gemini",
    OPENAI_API_KEY: "SECRET-openai",
    TYPESAFE_API_KEY: "SECRET-typesafe",
    NODE_OPTIONS: "--require=/malicious/module",
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/malicious/settings",
  };
  return {
    root, credential, env,
    provider: createCliProvider({ provider: "google", model }, { env, fixtureCommand, ...overrides }),
  };
}

test("streams validated assistant deltas from a real subprocess", async () => {
  // Given
  const { provider } = await setup();
  const deltas: string[] = [];
  // When
  const answer = await provider.stream(request, (part) => deltas.push(part), new AbortController().signal);
  // Then
  expect(answer).toBe("한글 response");
  expect(deltas).toEqual(["한글", " response"]);
});

test.each([
  "malformed", "invalid-utf8", "wrong-delta", "non-delta", "tool", "error",
  "terminal-error", "nonzero", "truncated", "no-terminal", "missing-init", "empty",
  "after-terminal", "no-final-newline",
])("rejects %s without returning raw subprocess errors", async (model) => {
  // Given
  const { provider } = await setup(model);
  // When
  const result = provider.stream(request, () => undefined, new AbortController().signal);
  // Then
  await expect(result).rejects.toEqual(new ChatProviderError());
});

const inspectionSchema = z.object({
  argv: z.array(z.string()), env: z.record(z.string(), z.string()),
  cwd: z.string(), cwdEntries: z.array(z.string()), homeEntries: z.array(z.string()),
  configEntries: z.array(z.string()), credential: z.string(),
  settings: z.object({
    tools: z.object({ core: z.array(z.string()) }),
    hooksConfig: z.object({ enabled: z.boolean() }),
    admin: z.object({
      mcp: z.object({ enabled: z.boolean() }),
      extensions: z.object({ enabled: z.boolean() }),
      skills: z.object({ enabled: z.boolean() }),
    }),
    security: z.object({ auth: z.object({ selectedType: z.string(), enforcedType: z.string() }) }),
  }),
  policy: z.string(), stdin: z.string(),
});

test("isolates config and environment while carrying untrusted text only through stdin", async () => {
  // Given
  const { provider, root, credential } = await setup("inspect");
  await writeFile(path.join(root, ".env"), "NODE_OPTIONS=SECRET");
  await writeFile(path.join(root, ".gemini/settings.json"), '{"hooksConfig":{"enabled":true}}');
  const marker = path.join(root, "should-not-exist");
  const dangerous = `$(touch ${marker}); \`touch ${marker}\` @/etc/passwd\n/quit`;
  const data = {
    locale: "en" as const,
    question: dangerous,
    history: [{ role: "user" as const, content: dangerous }],
    sources: [{ noteId: "note-1", title: dangerous, excerpt: dangerous }],
  };
  // When
  const answer = await provider.stream(data, () => undefined, new AbortController().signal);
  const inspected = inspectionSchema.parse(JSON.parse(answer));
  // Then
  expect(JSON.parse(inspected.stdin)).toEqual({
    instructions: cliInstructions("en"), question: data.question, history: data.history, sources: data.sources,
  });
  expect(inspected.stdin).not.toContain("@");
  expect(inspected.argv.join(" ")).not.toContain(dangerous);
  expect(inspected.argv.slice(0, 6)).toEqual(["--output-format", "stream-json", "--approval-mode", "default", "--extensions", "none"]);
  expect(inspected.env).toEqual({
    HOME: path.join(path.dirname(inspected.cwd), "home"),
    PATH: "/usr/bin:/bin", NODE_ENV: "production", LANG: "C.UTF-8", NO_BROWSER: "true",
    GEMINI_CLI_HOME: path.join(path.dirname(inspected.cwd), "home"),
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(path.dirname(inspected.cwd), "settings.json"),
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(path.dirname(inspected.cwd), "settings.json"),
  });
  expect(inspected.cwdEntries).toEqual([]);
  expect(inspected.homeEntries).toEqual([".gemini"]);
  expect(inspected.configEntries).toEqual(["oauth_creds.json"]);
  expect(inspected.credential).toBe(credential);
  expect(inspected.settings.tools.core).toEqual([]);
  expect(inspected.settings.hooksConfig.enabled).toBe(false);
  expect(inspected.settings.admin).toEqual({ mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } });
  expect(inspected.settings.security.auth).toEqual({ selectedType: "oauth-personal", enforcedType: "oauth-personal" });
  expect(Bun.TOML.parse(inspected.policy)).toEqual({ rule: [{ toolName: "*", decision: "deny", priority: 999 }] });
  await expect(access(marker)).rejects.toThrow();
  await expect(access(inspected.cwd)).rejects.toThrow();
  expect(await readFile(credential, "utf8")).toBe("fixture-credential-not-a-live-token");
});

test.each([
  ["stdout-limit", { maxOutputBytes: 1024 }],
  ["stderr-limit", { maxStderrBytes: 1024 }],
  ["line-limit", {}],
] as const)("bounds %s from a real subprocess", async (model, options) => {
  // Given
  const { provider } = await setup(model, options);
  // When
  const result = provider.stream(request, () => undefined, new AbortController().signal);
  // Then
  await expect(result).rejects.toEqual(new ChatProviderError());
});

test("rejects an aborted request before launching a subprocess", async () => {
  // Given
  const { provider } = await setup("hang");
  // When
  const result = provider.stream(request, () => undefined, AbortSignal.abort());
  // Then
  await expect(result).rejects.toEqual(new ChatProviderError());
});

test("terminates a hanging subprocess at the configured deadline", async () => {
  // Given: time itself is the behavior under test, with no sleeps or polling.
  const { provider } = await setup("hang", { timeoutMs: 100 });
  // When
  const result = provider.stream(request, () => undefined, new AbortController().signal);
  // Then
  await expect(result).rejects.toEqual(new ChatProviderError());
});

test.each(["tree", "tree-success"])("cleans up the process group on %s", async (model) => {
  // Given: subscribe to descendant readiness and socket closure BEFORE aborting.
  const server = createServer();
  const sockets: Socket[] = [];
  const connected = Promise.withResolvers<Promise<unknown[]>>();
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.resume();
    connected.resolve(once(socket, "close", { signal: AbortSignal.timeout(3000) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  const { provider } = await setup(model);
  const controller = new AbortController();
  const ready = Promise.withResolvers<string>();
  let subprocessRoot = "";
  // When
  const result = provider.stream({ ...request, question: String(address.port) }, (text) => {
    const info = z.object({ root: z.string() }).parse(JSON.parse(text));
    subprocessRoot = info.root;
    ready.resolve(text);
    if (model === "tree") controller.abort();
  }, controller.signal);
  // Attach a rejection handler immediately; readiness must never race it.
  const settled = result.then((text) => ({ text }), (error: unknown) => ({ error }));
  try {
    await Promise.race([ready.promise, settled.then((value) => {
      if ("error" in value) throw value.error;
      return value.text;
    })]);
    const completion = await settled;
    await connected.promise;
    // Then
    if (model === "tree") expect(completion).toEqual({ error: new ChatProviderError() });
    else expect(completion).toHaveProperty("text");
    await expect(access(subprocessRoot)).rejects.toThrow();
  } finally {
    controller.abort();
    sockets.forEach((socket) => socket.destroy());
    server.close();
    await settled;
  }
});

test("rejects callback failures and still removes private runtime files", async () => {
  // Given
  const { provider } = await setup("inspect");
  let cwd = "";
  // When
  const result = provider.stream(request, (text) => {
    cwd = inspectionSchema.parse(JSON.parse(text)).cwd;
    throw new Error("SECRET callback");
  }, new AbortController().signal);
  // Then
  await expect(result).rejects.toEqual(new ChatProviderError());
  await expect(access(cwd)).rejects.toThrow();
});

test("handles executable launch failures with the generic provider error", async () => {
  // Given
  const { provider } = await setup("success", { fixtureCommand: { runtime: "/missing/cli", script: fixtureCommand.script } });
  // When
  const result = provider.stream(request, () => undefined, new AbortController().signal);
  // Then
  await expect(result).rejects.toEqual(new ChatProviderError());
});
