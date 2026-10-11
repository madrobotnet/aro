import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AiSettingsInput, ConnectionProfileInput } from "@/lib/ai-settings";
import { browserHash, installerToken, readySQLiteGrant, sqliteAuthFixture, sqliteOwnerScope } from "@/server/ai-auth/sqlite-test-fixture";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { requireInstallerAccess } from "./access";
import { saveConnectionProfile, deleteConnectionProfile } from "./ai-profiles";
import { connectionProfiles, settingsDocument } from "./ai-profile-store";
import { completeSetup } from "./service";
import { aiSettingsView, saveAiSettings, storedAiSettings } from "./settings";

sqliteAuthFixture();
const disabled: AiSettingsInput = { chat: null, chatConsent: false, jev: null, jevConsent: false };
const api: ConnectionProfileInput = {
  purpose: "chat", name: "API fixture", consent: true,
  connection: { mode: "api", provider: "openai", model: "fixture", apiKey: "fixture-private-key" },
};

test("API profiles survive reopen, preserve hidden keys, and selection and deletion remain native", async () => {
  // Given
  await sqliteOwnerScope();
  const profile = await saveConnectionProfile(api);
  await saveAiSettings({ ...disabled, chat: { mode: "saved", id: profile.id }, chatConsent: true });
  await closeSQLiteStore();
  // When
  await saveConnectionProfile({
    ...api, name: "Updated", connection: { mode: "api", provider: "openai", model: "next" },
  }, { id: profile.id.toUpperCase() });
  // Then
  expect((await storedAiSettings())?.chat).toMatchObject({ apiKey: "fixture-private-key", model: "next" });
  expect(JSON.stringify(await aiSettingsView())).not.toContain("fixture-private-key");
  await deleteConnectionProfile(profile.id.toUpperCase());
  expect((await settingsDocument())?.chatId).toBeNull();
  expect((await storedAiSettings())?.chat).toBeNull();
});

test("settings consent and saved purpose binding reject without changing selections", async () => {
  // Given
  await sqliteOwnerScope();
  const profile = await saveConnectionProfile(api);
  // When / Then
  await expect(saveAiSettings({ ...disabled, chat: { mode: "saved", id: profile.id } }))
    .rejects.toMatchObject({ code: "validation" });
  await expect(saveAiSettings({ ...disabled, jev: { mode: "saved", id: profile.id }, jevConsent: true }))
    .rejects.toMatchObject({ code: "validation" });
  expect(await settingsDocument()).toEqual({ version: 2, chatId: null, jevId: null });
});

test("browser and owner binding protect a ready grant and successful consumption is one-time", async () => {
  // Given
  const scope = await sqliteOwnerScope();
  const id = await readySQLiteGrant(scope, { provider: "openrouter", accessToken: "fixture-openrouter-key" });
  const input: ConnectionProfileInput = {
    purpose: "jev", name: "Authorized Jev", consent: true,
    connection: { mode: "auth", provider: "openrouter", model: "jev", authAttemptId: id },
  };
  // When / Then
  await expect(saveConnectionProfile(input, { browserHash: "wrong" })).rejects.toMatchObject({ code: "forbidden" });
  const profile = await saveConnectionProfile(input, { browserHash });
  expect(profile.connection).toMatchObject({ credential: { accessToken: "fixture-openrouter-key" } });
  await expect(saveConnectionProfile(input, { browserHash })).rejects.toMatchObject({ code: "forbidden" });
  expect((await sqliteStore()).all("SELECT id FROM ai_connections")).toHaveLength(1);
});

test("wrong owner, provider, expiry and pending grants remain unconsumed", async () => {
  // Given
  const scope = await sqliteOwnerScope();
  const store = await sqliteStore();
  for (const invalid of ["owner", "provider", "expiry", "pending"] as const) {
    const id = await readySQLiteGrant(scope, { provider: "openrouter", accessToken: "fixture-key" });
    if (invalid === "owner") store.run("UPDATE ai_auth_attempts SET scope_key='owner:other' WHERE id=?", [id]);
    if (invalid === "provider") store.run("UPDATE ai_auth_attempts SET provider='google' WHERE id=?", [id]);
    if (invalid === "expiry") store.run("UPDATE ai_auth_attempts SET expires_at='2000-01-01T00:00:00.000000Z' WHERE id=?", [id]);
    if (invalid === "pending") store.run("UPDATE ai_auth_attempts SET status='pending' WHERE id=?", [id]);
    // When / Then
    await expect(saveConnectionProfile({
      purpose: "jev", name: "Rejected", consent: true,
      connection: { mode: "auth", provider: "openrouter", model: "jev", authAttemptId: id },
    }, { browserHash })).rejects.toMatchObject({ code: invalid === "owner" || invalid === "provider" ? "forbidden" : "conflict" });
    expect(store.get("SELECT id FROM ai_auth_attempts WHERE id=?", [id])).not.toBeNull();
  }
  expect(store.all("SELECT id FROM ai_connections")).toHaveLength(0);
});

test("setup atomically consumes browser grants and saves API and authorized profiles through reopen", async () => {
  // Given
  const scope = { key: await requireInstallerAccess(installerToken), browserHash };
  const id = await readySQLiteGrant(scope, { provider: "openrouter", accessToken: "setup-private-key" });
  // When
  await completeSetup({ setupToken: installerToken, password: "fixture-long-password",
    ai: { chat: api.connection, chatConsent: true,
      jev: { mode: "auth", provider: "openrouter", model: "jev", authAttemptId: id }, jevConsent: true },
  }, { browserHash });
  await closeSQLiteStore();
  // Then
  const store = await sqliteStore();
  expect(store.all("SELECT id FROM users")).toHaveLength(1);
  expect(store.all("SELECT id FROM ai_connections")).toHaveLength(2);
  expect(store.all("SELECT id FROM ai_auth_attempts")).toHaveLength(0);
  expect(await storedAiSettings()).toMatchObject({
    chat: { apiKey: "fixture-private-key" }, jev: { apiKey: "setup-private-key" },
  });
});

test("settings failure rolls back profiles and consumed grants together", async () => {
  // Given
  const scope = await sqliteOwnerScope();
  const id = await readySQLiteGrant(scope, { provider: "openrouter", accessToken: "fixture-key" });
  using connection = new Database(process.env.ARO_SQLITE_PATH);
  connection.run(`CREATE TRIGGER fail_ai_update BEFORE UPDATE ON installation_settings
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  // When
  await expect(saveAiSettings({ ...disabled, jevConsent: true,
    jev: { mode: "auth", provider: "openrouter", model: "jev", authAttemptId: id },
  }, { browserHash })).rejects.toThrow("fixture failure");
  // Then
  expect((await sqliteStore()).all("SELECT id FROM ai_connections")).toHaveLength(0);
  expect((await sqliteStore()).get("SELECT id FROM ai_auth_attempts WHERE id=?", [id])).not.toBeNull();
});

test("setup failure after grant consumption rolls back owner profiles and grant deletion", async () => {
  // Given
  const scope = { key: await requireInstallerAccess(installerToken), browserHash };
  const id = await readySQLiteGrant(scope, { provider: "openrouter", accessToken: "fixture-key" });
  using connection = new Database(process.env.ARO_SQLITE_PATH);
  connection.run(`CREATE TRIGGER fail_ai_setup BEFORE INSERT ON installation_settings
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  // When
  await expect(completeSetup({ setupToken: installerToken, password: "fixture-long-password",
    ai: { ...disabled, jevConsent: true,
      jev: { mode: "auth", provider: "openrouter", model: "jev", authAttemptId: id } },
  }, { browserHash })).rejects.toThrow("fixture failure");
  // Then
  const store = await sqliteStore();
  expect(store.all("SELECT id FROM users")).toHaveLength(0);
  expect(store.all("SELECT id FROM ai_connections")).toHaveLength(0);
  expect(store.get("SELECT id FROM ai_auth_attempts WHERE id=?", [id])).not.toBeNull();
});

test("native profile count limits do not consume an additional grant", async () => {
  // Given
  const scope = await sqliteOwnerScope();
  for (let i = 0; i < 40; i++) await saveConnectionProfile({ ...api, name: `Fixture ${i}` });
  const id = await readySQLiteGrant(scope, { provider: "openrouter", accessToken: "fixture-key" });
  // When
  await expect(saveConnectionProfile({
    purpose: "jev", name: "Extra", consent: true,
    connection: { mode: "auth", provider: "openrouter", model: "jev", authAttemptId: id },
  }, { browserHash })).rejects.toMatchObject({ code: "validation" });
  // Then
  expect(await connectionProfiles(scope.key.slice(6))).toHaveLength(40);
  expect((await sqliteStore()).get("SELECT id FROM ai_auth_attempts WHERE id=?", [id])).not.toBeNull();
});
