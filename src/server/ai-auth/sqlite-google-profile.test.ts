import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ChatProviderError } from "@/server/chat/provider";
import { connectionProfiles } from "@/server/setup/ai-profile-store";
import { deleteConnectionProfile, saveConnectionProfile } from "@/server/setup/ai-profiles";
import { closeSQLiteStore } from "@/server/db/backend";
import { createGoogleProfileProvider } from "./google-profile";
import { browserHash, readySQLiteGrant, sqliteAuthFixture, sqliteOwnerScope } from "./sqlite-test-fixture";

sqliteAuthFixture();
const runtime = Bun.which("node");
if (!runtime) throw new Error("Node is required for the existing CLI fixture");
const fixtureCommand = { runtime, script: join(import.meta.dir, "../chat/cli-profile-fixture.ts") };
const request = (access: string, next: string, extra = {}) => ({
  question: JSON.stringify({ access, refresh: `${access}-refresh`, next, ...extra }), history: [], sources: [],
});
async function saveGoogle(access: string, scope: Awaited<ReturnType<typeof sqliteOwnerScope>>) {
  const grant = await readySQLiteGrant(scope, {
    provider: "google", accessToken: access, refreshToken: `${access}-refresh`, expiresAt: 0,
  });
  return saveConnectionProfile({
    purpose: "chat", name: "Google fixture", consent: true,
    connection: { mode: "auth", provider: "google", model: "fixture-model", authAttemptId: grant },
  }, { browserHash });
}

test.each(["success", "fail"] as const)("Google isolated CLI writeback persists native refresh on %s", async mode => {
  // Given
  const scope = await sqliteOwnerScope();
  const profile = await saveGoogle("one", scope);
  const provider = createGoogleProfileProvider(profile.id, { fixtureCommand });
  // When
  const result = provider.stream(request("one", "rotated", { mode }), () => undefined, AbortSignal.timeout(3000));
  // Then
  if (mode === "success") expect(await result).toBeString();
  else await expect(result).rejects.toEqual(new ChatProviderError());
  await closeSQLiteStore();
  expect(await connectionProfiles(scope.key.slice(6))).toMatchObject([{
    connection: { credential: { accessToken: "rotated", refreshToken: "one-refresh" } },
  }]);
});

test.each(["edit", "delete", "reconnect"] as const)("Google late CLI writeback preserves %s and does not block unrelated profiles", async action => {
  // Given
  const scope = await sqliteOwnerScope();
  const profile = await saveGoogle("one", scope);
  const other = await saveGoogle("two", scope);
  const server = createServer();
  const connection = Promise.withResolvers<{ socket: Socket; ready: Promise<unknown[]> }>();
  server.once("connection", socket => {
    connection.resolve({ socket, ready: once(socket, "data", { signal: AbortSignal.timeout(3000) }) });
  });
  const listening = once(server, "listening", { signal: AbortSignal.timeout(3000) });
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  let socket: Socket | undefined;
  const first = createGoogleProfileProvider(profile.id, { fixtureCommand })
    .stream(request("one", "rotated", { port: address.port }), () => undefined, AbortSignal.timeout(5000));
  const settled = first.then(text => ({ text }), (error: unknown) => ({ error }));
  // When / Then
  try {
    const connected = await Promise.race([
      connection.promise, settled.then(() => { throw new Error("Fixture exited before credential handshake"); }),
    ]);
    socket = connected.socket;
    await connected.ready;
    await expect(createGoogleProfileProvider(profile.id, { fixtureCommand })
      .stream(request("one", "unused"), () => undefined, AbortSignal.timeout(3000))).rejects.toEqual(new ChatProviderError());
    expect(await createGoogleProfileProvider(other.id, { fixtureCommand })
      .stream(request("two", "two-next"), () => undefined, AbortSignal.timeout(3000))).toBeString();
    if (action === "delete") await deleteConnectionProfile(profile.id);
    else {
      const grant = action === "reconnect" ? await readySQLiteGrant(scope, {
        provider: "google", accessToken: "reconnected", refreshToken: "reconnected-refresh", expiresAt: 0,
      }) : undefined;
      await saveConnectionProfile({
        purpose: "chat", name: "Edited", consent: true,
        connection: { mode: "auth", provider: "google", model: "edited-model",
          ...(grant ? { authAttemptId: grant } : {}) },
      }, { id: profile.id, browserHash });
    }
    socket.write("release");
    await first;
    const saved = (await connectionProfiles(scope.key.slice(6))).find(p => p.id === profile.id);
    if (action === "delete") expect(saved).toBeUndefined();
    else expect(saved).toMatchObject({ name: "Edited", connection: {
      model: "edited-model", credential: { accessToken: action === "reconnect" ? "reconnected" : "rotated" },
    } });
  } finally {
    socket?.write("release");
    socket?.destroy();
    server.close();
    await settled;
  }
});

test("corrupt CLI refresh writeback retains the last valid credential and blocks replay across reopen", async () => {
  // Given
  const scope = await sqliteOwnerScope();
  const profile = await saveGoogle("one", scope);
  const provider = createGoogleProfileProvider(profile.id, { fixtureCommand });
  // When
  await expect(provider.stream(request("one", "rotated", { mode: "corrupt" }), () => undefined, AbortSignal.timeout(3000)))
    .rejects.toEqual(new ChatProviderError());
  await closeSQLiteStore();
  // Then
  expect(await connectionProfiles(scope.key.slice(6))).toMatchObject([{ connection: { credential: { accessToken: "one" } } }]);
  await expect(provider.stream(request("one", "unused"), () => undefined, AbortSignal.timeout(3000)))
    .rejects.toEqual(new ChatProviderError());
});
