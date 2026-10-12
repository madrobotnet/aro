import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GoogleCredential } from "@/lib/ai-auth";
import { createCliProvider } from "./cli-provider";
import { ChatProviderError } from "./provider";

const runtime = Bun.which("node");
if (!runtime) throw new Error("Node is required for CLI fixtures");
const fixtureCommand = { runtime, script: path.join(import.meta.dir, "cli-profile-fixture.ts") };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

for (const mode of ["success", "fail", "abort", "corrupt"] as const) {
  test(`saved Google credential is isolated and refresh readback survives ${mode}`, async () => {
    // Given: a different global credential must never be read or changed.
    const root = await mkdtemp("/tmp/sb-cli-profile-test-");
    roots.push(root);
    await mkdir(path.join(root, ".gemini"));
    const global = path.join(root, ".gemini/oauth_creds.json");
    await writeFile(global, "global-must-not-change");
    const credential: GoogleCredential = { provider: "google", accessToken: "profile-access", refreshToken: "profile-refresh", expiresAt: 0 };
    const saved: GoogleCredential[] = [];
    const provider = createCliProvider({ provider: "google", model: "fixture" }, {
      fixtureCommand, env: { GEMINI_CLI_HOME: root, PATH: "/usr/bin:/bin", DATABASE_URL: "private-db" },
      session: { credential, persist: async (next) => { saved.push(next); } },
    });
    const controller = new AbortController();
    let privateRoot = "";
    // When
    const result = provider.stream({ question: JSON.stringify({ access: "profile-access", refresh: "profile-refresh", next: "rotated-access", mode }), history: [], sources: [] }, (text) => {
      privateRoot = text;
      if (mode === "abort") controller.abort();
    }, controller.signal);
    // Then
    if (mode === "success") await expect(result).resolves.toBeString();
    else await expect(result).rejects.toEqual(new ChatProviderError());
    if (mode === "corrupt") expect(saved).toEqual([]);
    else expect(saved).toEqual([{ ...credential, accessToken: "rotated-access", expiresAt: 4_000_000_000_000, tokenType: "Bearer" }]);
    expect(await readFile(global, "utf8")).toBe("global-must-not-change");
    expect(privateRoot).toMatch(/^\/tmp\/aro-cli-/);
    await expect(access(privateRoot)).rejects.toThrow();
  });
}
