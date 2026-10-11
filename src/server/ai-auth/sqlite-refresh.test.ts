import { expect, test } from "bun:test";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { saveConnectionProfile, deleteConnectionProfile } from "@/server/setup/ai-profiles";
import { connectionProfiles } from "@/server/setup/ai-profile-store";
import { refreshedConnectionProfile } from "./refresh";
import { bounded, browserHash, fakeFetch, fixedNow, readySQLiteGrant, sqliteAuthFixture, sqliteOwnerScope } from "./sqlite-test-fixture";

sqliteAuthFixture();
async function expiredProfile() {
  const scope = await sqliteOwnerScope();
  const grant = await readySQLiteGrant(scope, {
    provider: "xai", accessToken: "old-access", refreshToken: "old-refresh", expiresAt: fixedNow - 1,
  });
  const profile = await saveConnectionProfile({
    purpose: "chat", name: "Refresh fixture", consent: true,
    connection: { mode: "auth", provider: "xai", model: "grok-fixture", authAttemptId: grant },
  }, { browserHash });
  return { profile, scope };
}

test("concurrent refresh reservations prevent a second rotating token POST while preserving edits", async () => {
  // Given
  const { profile } = await expiredProfile();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const fetchImpl = fakeFetch(async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return Response.json({ access_token: "next-access", refresh_token: "next-refresh", expires_in: 3600 });
  });
  const entry = bounded(entered.promise);
  const refreshing = refreshedConnectionProfile(profile.id, { fetchImpl, now: () => fixedNow });
  const followers: Promise<Awaited<typeof refreshing>>[] = [];
  // When / Then
  try {
    await entry;
    followers.push(refreshedConnectionProfile(profile.id, { fetchImpl, now: () => fixedNow }));
    await saveConnectionProfile({
      purpose: "chat", name: "Edited during refresh", consent: true,
      connection: { mode: "auth", provider: "xai", model: "edited-model" },
    }, { id: profile.id, browserHash });
    followers.push(refreshedConnectionProfile(profile.id, { fetchImpl, now: () => fixedNow }));
    expect(calls).toBe(1);
  } finally { release.resolve(); }
  expect(await refreshing).toMatchObject({ name: "Edited during refresh", connection: {
    model: "edited-model", credential: { accessToken: "next-access", refreshToken: "next-refresh" },
  } });
  for (const follower of followers) expect(await follower).toMatchObject({
    name: "Edited during refresh", connection: { credential: { refreshToken: "next-refresh" } },
  });
  await closeSQLiteStore();
  expect(await refreshedConnectionProfile(profile.id, { fetchImpl, now: () => fixedNow })).toMatchObject({
    connection: { credential: { refreshToken: "next-refresh" } },
  });
  expect(calls).toBe(1);
});

test.each(["delete", "reconnect"] as const)("late refresh cannot overwrite %s", async action => {
  // Given
  const { profile, scope } = await expiredProfile();
  const fetchImpl = fakeFetch(async () => {
    if (action === "delete") await deleteConnectionProfile(profile.id);
    else {
      const grant = await readySQLiteGrant(scope, {
        provider: "xai", accessToken: "reconnected-access", refreshToken: "reconnected-refresh", expiresAt: fixedNow + 3600000,
      });
      await saveConnectionProfile({
        purpose: "chat", name: "Reconnected", consent: true,
        connection: { mode: "auth", provider: "xai", model: "reconnected-model", authAttemptId: grant },
      }, { id: profile.id, browserHash });
    }
    return Response.json({ access_token: "stale-access", refresh_token: "stale-refresh", expires_in: 3600 });
  });
  // When
  const updated = await refreshedConnectionProfile(profile.id, { fetchImpl, now: () => fixedNow });
  // Then
  if (action === "delete") expect(updated).toBeNull();
  else expect(updated).toMatchObject({ name: "Reconnected", connection: { credential: { accessToken: "reconnected-access" } } });
  expect(JSON.stringify(await connectionProfiles(scope.key.slice(6)))).not.toContain("stale-access");
  expect((await sqliteStore()).all("SELECT id FROM ai_auth_attempts WHERE scope_key LIKE 'refresh:%'")).toHaveLength(0);
});

test("ambiguous refresh failures stay reserved across reopen until credentials are replaced", async () => {
  // Given
  const { profile, scope } = await expiredProfile();
  let calls = 0;
  const fetchImpl = fakeFetch(() => {
    calls++;
    throw new TypeError("fixture disconnect after possible rotation");
  });
  // When
  await expect(refreshedConnectionProfile(profile.id, { fetchImpl, now: () => fixedNow })).rejects.toMatchObject({ code: "unavailable" });
  await closeSQLiteStore();
  await expect(refreshedConnectionProfile(profile.id, { fetchImpl, now: () => fixedNow })).rejects.toMatchObject({ code: "unavailable" });
  // Then
  expect(calls).toBe(1);
  const id = await readySQLiteGrant(scope, {
    provider: "xai", accessToken: "fresh-access", refreshToken: "fresh-refresh", expiresAt: fixedNow + 3600000,
  });
  await saveConnectionProfile({
    purpose: "chat", name: "Fresh", consent: true,
    connection: { mode: "auth", provider: "xai", model: "grok", authAttemptId: id },
  }, { id: profile.id, browserHash });
  expect(await refreshedConnectionProfile(profile.id, { fetchImpl, now: () => fixedNow })).toMatchObject({
    connection: { credential: { accessToken: "fresh-access" } },
  });
  expect(calls).toBe(1);
});

test("explicit server refresh failures release reservations for a safe retry", async () => {
  // Given
  const { profile } = await expiredProfile();
  let calls = 0;
  const fetchImpl = fakeFetch(() => {
    calls++;
    return calls === 1 ? Response.json({ error: "server_error" }, { status: 503 })
      : Response.json({ access_token: "next-access", refresh_token: "next-refresh", expires_in: 3600 });
  });
  // When
  await expect(refreshedConnectionProfile(profile.id, { fetchImpl, now: () => fixedNow })).rejects.toMatchObject({ code: "unavailable" });
  const updated = await refreshedConnectionProfile(profile.id, { fetchImpl, now: () => fixedNow });
  // Then
  expect(updated).toMatchObject({ connection: { credential: { refreshToken: "next-refresh" } } });
  expect(calls).toBe(2);
});
