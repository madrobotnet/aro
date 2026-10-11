import { db } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";

export type DailyDay = { date: string; noteId: string };
export type DailyMonth = { month: string; days: DailyDay[] };

/** Daily notes (archived included, trash excluded) for one YYYY-MM month, oldest first. */
export async function listDailyMonth(month: string): Promise<DailyMonth> {
  if (databaseBackend() === "sqlite") {
    const rows = (await sqliteStore()).all<{ date: string; note_id: string }>(
      "SELECT daily_date AS date,id AS note_id FROM notes WHERE deleted_at IS NULL AND daily_date>=? AND daily_date<date(?,'+1 month') ORDER BY daily_date",
      [`${month}-01`, `${month}-01`],
    );
    return { month, days: rows.map(row => ({ date: row.date, noteId: row.note_id })) };
  }
  const pool = await db();
  const result = await pool.query<{ date: string; note_id: string }>(
    `SELECT to_char(daily_date,'YYYY-MM-DD') AS date,id AS note_id FROM notes
      WHERE deleted_at IS NULL AND daily_date >= $1::date AND daily_date < $1::date + interval '1 month'
      ORDER BY daily_date`,
    [`${month}-01`],
  );
  return { month, days: result.rows.map((row) => ({ date: row.date, noteId: row.note_id })) };
}
