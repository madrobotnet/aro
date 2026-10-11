import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { createTemplate, deleteTemplate, listTemplates, updateTemplate } from "./service";

const directory = await mkdtemp(join(tmpdir(), "aro-templates-"));
const oldMode = process.env.ARO_DATABASE_MODE;
const oldPath = process.env.ARO_SQLITE_PATH;
beforeEach(async () => {
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "templates.sqlite");
  (await sqliteStore()).run("DELETE FROM note_templates");
});
afterAll(async () => {
  await closeSQLiteStore();
  if (oldMode === undefined) delete process.env.ARO_DATABASE_MODE;
  else process.env.ARO_DATABASE_MODE = oldMode;
  if (oldPath === undefined) delete process.env.ARO_SQLITE_PATH;
  else process.env.ARO_SQLITE_PATH = oldPath;
  await rm(directory, { recursive: true, force: true });
});

test("switches daily defaults atomically and preserves bodies", async () => {
  const first = await createTemplate({ name: "Meeting", body: "{{date}}", isDailyDefault: true });
  const second = await createTemplate({ name: "Daily", body: "# {{title}}", isDailyDefault: true });
  expect((await listTemplates()).filter(row => row.isDailyDefault).map(row => row.id)).toEqual([second.id]);
  await updateTemplate(first.id.toUpperCase(), { isDailyDefault: true });
  expect((await listTemplates()).filter(row => row.isDailyDefault).map(row => row.id)).toEqual([first.id]);
  expect((await listTemplates()).find(row => row.id === second.id)?.body).toBe("# {{title}}");
});

test("duplicate or missing updates do not clear the existing default", async () => {
  const first = await createTemplate({ name: "Daily", isDailyDefault: true });
  await expect(createTemplate({ name: "Daily", isDailyDefault: true })).rejects.toMatchObject({ code: "conflict" });
  await expect(updateTemplate(crypto.randomUUID(), { isDailyDefault: true })).rejects.toMatchObject({ code: "not_found" });
  expect((await listTemplates()).filter(row => row.isDailyDefault).map(row => row.id)).toEqual([first.id]);
});

test("deletes the selected template and reports missing identity", async () => {
  const item = await createTemplate({ name: "Temporary" });
  await deleteTemplate(item.id);
  expect(await listTemplates()).toEqual([]);
  await expect(deleteTemplate(item.id)).rejects.toMatchObject({ code: "not_found" });
});
