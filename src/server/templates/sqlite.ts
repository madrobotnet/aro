import type { NoteTemplate } from "@/lib/templates";
import { sqliteStore } from "@/server/db/backend";
import { readSQLiteBoolean, sqliteTimestamp, sqliteUuid } from "@/server/db/sqlite/values";
import { ApiError } from "@/server/http";
import { templatesCopy } from "./copy";
import type { CreateTemplateInput, UpdateTemplateInput } from "./service";

type Row = {
  id: string; name: string; body: string; is_daily_default: bigint;
  created_at: string; updated_at: string;
};
const map = (row: Row): NoteTemplate => ({
  id: row.id, name: row.name, body: row.body,
  isDailyDefault: readSQLiteBoolean(row.is_daily_default),
  createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
});

export async function listTemplatesSQLite(): Promise<NoteTemplate[]> {
  return (await sqliteStore()).all<Row>("SELECT * FROM note_templates").sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name),
  ).map(map);
}

export async function createTemplateSQLite(input: CreateTemplateInput): Promise<NoteTemplate> {
  const store = await sqliteStore();
  return store.transaction(tx => {
    if (tx.get("SELECT id FROM note_templates WHERE name=?", [input.name])) {
      throw new ApiError("conflict", templatesCopy.nameTaken);
    }
    if (input.isDailyDefault) tx.run(
      "UPDATE note_templates SET is_daily_default=0,updated_at=? WHERE is_daily_default=1",
      [sqliteTimestamp(new Date())],
    );
    const row = tx.get<Row>("INSERT INTO note_templates(name,body,is_daily_default) VALUES (?,?,?) RETURNING *",
      [input.name, input.body ?? "", input.isDailyDefault ? 1 : 0]);
    if (!row) throw new ApiError("internal", "Template insert returned no row");
    return map(row);
  });
}

export async function updateTemplateSQLite(id: string, input: UpdateTemplateInput): Promise<NoteTemplate> {
  const store = await sqliteStore();
  const key = sqliteUuid(id);
  return store.transaction(tx => {
    if (!tx.get("SELECT id FROM note_templates WHERE id=?", [key])) {
      throw new ApiError("not_found", templatesCopy.notFound);
    }
    if (input.name !== undefined && tx.get("SELECT id FROM note_templates WHERE name=? AND id<>?", [input.name, key])) {
      throw new ApiError("conflict", templatesCopy.nameTaken);
    }
    const now = sqliteTimestamp(new Date());
    if (input.isDailyDefault) tx.run(
      "UPDATE note_templates SET is_daily_default=0,updated_at=? WHERE is_daily_default=1 AND id<>?", [now, key],
    );
    const row = tx.get<Row>(
      "UPDATE note_templates SET name=coalesce(?,name),body=coalesce(?,body),is_daily_default=coalesce(?,is_daily_default),updated_at=? WHERE id=? RETURNING *",
      [input.name ?? null, input.body ?? null, input.isDailyDefault === undefined ? null : Number(input.isDailyDefault), now, key],
    );
    if (!row) throw new ApiError("not_found", templatesCopy.notFound);
    return map(row);
  });
}

export async function deleteTemplateSQLite(id: string): Promise<void> {
  if ((await sqliteStore()).run("DELETE FROM note_templates WHERE id=?", [sqliteUuid(id)]).changes === 0) {
    throw new ApiError("not_found", templatesCopy.notFound);
  }
}
