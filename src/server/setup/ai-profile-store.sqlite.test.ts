import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { aiSelection, connectionProfiles, settingsDocument, settingsOwner } from "./ai-profile-store";
import { aiSettingsView, storedAiSettings } from "./settings";

test("SQLite AI-off selection stays off with ambient credentials and no PostgreSQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-ai-off-"));
  const previous = { ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE,
    ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY };
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "owner.sqlite");
  process.env.TYPESAFE_API_KEY = "synthetic-ambient-key-never-called";
  try {
    const store = await sqliteStore();
    const owner = store.get<{ id: string }>("INSERT INTO users(password_hash) VALUES (?) RETURNING id", ["fixture"]);
    if (!owner) throw new Error("Missing test owner");
    store.run("INSERT INTO installation_settings(singleton,owner_id,setup_completed,ai) VALUES (1,?,1,?)",
      [owner.id, JSON.stringify({ version: 2, chatId: null, jevId: null })]);
    expect(await settingsOwner()).toBe(owner.id);
    expect(await settingsDocument()).toEqual({ version: 2, chatId: null, jevId: null });
    expect(await connectionProfiles(owner.id)).toEqual([]);
    expect(await aiSelection("chat")).toEqual({ source: "disabled" });
    expect(await aiSelection("jev")).toEqual({ source: "disabled" });
    expect(await storedAiSettings()).toEqual({ chat: null, jev: null });
    expect(await aiSettingsView()).toMatchObject({ chat: null, jev: null, profiles: [],
      chatManagedByEnvironment: false, jevManagedByEnvironment: false });
  } finally {
    await closeSQLiteStore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
