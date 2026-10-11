import { DatabaseError, type PoolClient, type QueryResultRow } from "pg";
import type { NoteTemplate } from "@/lib/templates";
import { db, tx } from "@/server/db";
import { databaseBackend } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { assertNoteId } from "@/server/notes/service";
import { templatesCopy } from "./copy";

type Executor = Pick<PoolClient, "query">;
type TemplateRow = QueryResultRow & {
  id: string; name: string; body: string; is_daily_default: boolean; created_at: Date; updated_at: Date;
};
export type CreateTemplateInput = { name: string; body?: string; isDailyDefault?: boolean };
export type UpdateTemplateInput = { name?: string; body?: string; isDailyDefault?: boolean };

const DAILY_DEFAULT_LOCK = "note_templates:daily_default";

function mapTemplate(row: TemplateRow): NoteTemplate {
  return {
    id: row.id, name: row.name, body: row.body, isDailyDefault: row.is_daily_default,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

/** Body of the daily-note default template, or null when none is marked. */
export async function defaultDailyTemplateBody(q: Executor): Promise<string | null> {
  const result = await q.query<{ body: string }>("SELECT body FROM note_templates WHERE is_daily_default LIMIT 1");
  return result.rows[0]?.body ?? null;
}

/** Serialize default changes so clearing the old default and marking the new one is atomic. */
async function clearOtherDefaults(client: PoolClient, keepId: string | null): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [DAILY_DEFAULT_LOCK]);
  await client.query(
    "UPDATE note_templates SET is_daily_default=false,updated_at=now() WHERE is_daily_default AND id IS DISTINCT FROM $1::uuid",
    [keepId],
  );
}

function nameConflict(error: unknown): never {
  if (error instanceof DatabaseError && error.code === "23505" && error.constraint === "note_templates_name_key") {
    throw new ApiError("conflict", templatesCopy.nameTaken);
  }
  throw error;
}

export async function listTemplates(): Promise<NoteTemplate[]> {
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).listTemplatesSQLite();
  const pool = await db();
  const result = await pool.query<TemplateRow>("SELECT * FROM note_templates ORDER BY lower(name) COLLATE \"C\",name COLLATE \"C\"");
  return result.rows.map(mapTemplate);
}

export async function createTemplate(input: CreateTemplateInput): Promise<NoteTemplate> {
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).createTemplateSQLite(input);
  return tx(async (client) => {
    if (input.isDailyDefault) await clearOtherDefaults(client, null);
    const result = await client.query<TemplateRow>(
      "INSERT INTO note_templates (name,body,is_daily_default) VALUES ($1,$2,$3) RETURNING *",
      [input.name, input.body ?? "", input.isDailyDefault ?? false],
    ).catch(nameConflict);
    return mapTemplate(result.rows[0]!);
  });
}

export async function updateTemplate(id: string, input: UpdateTemplateInput): Promise<NoteTemplate> {
  assertNoteId(id);
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).updateTemplateSQLite(id, input);
  return tx(async (client) => {
    if (input.isDailyDefault) await clearOtherDefaults(client, id);
    const result = await client.query<TemplateRow>(
      `UPDATE note_templates SET name=coalesce($2,name),body=coalesce($3,body),
         is_daily_default=coalesce($4,is_daily_default),updated_at=now() WHERE id=$1 RETURNING *`,
      [id, input.name ?? null, input.body ?? null, input.isDailyDefault ?? null],
    ).catch(nameConflict);
    const row = result.rows[0];
    if (!row) throw new ApiError("not_found", templatesCopy.notFound);
    return mapTemplate(row);
  });
}

export async function deleteTemplate(id: string): Promise<void> {
  assertNoteId(id);
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).deleteTemplateSQLite(id);
  const pool = await db();
  const result = await pool.query("DELETE FROM note_templates WHERE id=$1", [id]);
  if (result.rowCount === 0) throw new ApiError("not_found", templatesCopy.notFound);
}
