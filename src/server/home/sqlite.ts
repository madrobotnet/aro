import { createHash } from "node:crypto";
import type { HomeData, NoteSummary } from "@/lib/types";
import { excerpt } from "@/lib/wikilinks";
import { sqliteStore } from "@/server/db/backend";
import { readSQLiteBoolean, readSQLiteNumber, readSQLiteStringArray } from "@/server/db/sqlite/values";
import { listInbox } from "@/server/inbox";
import { listNotes, listTags } from "@/server/notes/service";

type Row = { id: string; title: string; body: string; tags: string; pinned: bigint; status: string;
  daily_date: string | null; created_at: string; updated_at: string };
const summary = (row: Row): NoteSummary => ({
  id: row.id, title: row.title, excerpt: excerpt(row.body), tags: readSQLiteStringArray(row.tags),
  pinned: readSQLiteBoolean(row.pinned), archived: row.status === "archived",
  dailyDate: row.daily_date, createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

export async function homeSQLite(today: string): Promise<HomeData> {
  const store = await sqliteStore();
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 14);
  const candidates = store.all<{ id: string }>(
    "SELECT id FROM notes WHERE deleted_at IS NULL AND status<>'archived' AND updated_at<?",
    [cutoff.toISOString()],
  );
  const ranked = candidates.map(row => ({
    id: row.id, rank: createHash("md5").update(`${row.id}:${today}`).digest("hex"),
  })).sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id)).slice(0, 3);
  const daily = store.get<Row>("SELECT * FROM notes WHERE daily_date=? AND deleted_at IS NULL LIMIT 1", [today]);
  const resurface = ranked.flatMap(row => {
    const note = store.get<Row>("SELECT * FROM notes WHERE id=?", [row.id]);
    return note ? [summary(note)] : [];
  });
  const stats = store.get<{ notes: bigint; links: bigint }>(
    `SELECT (SELECT count(*) FROM notes WHERE deleted_at IS NULL) AS notes,
      (SELECT count(*) FROM links l JOIN notes s ON s.id=l.from_note_id AND s.deleted_at IS NULL
       JOIN notes t ON t.id=l.to_note_id AND t.deleted_at IS NULL) AS links`,
  );
  const [inbox, recent, pinned, tags] = await Promise.all([
    listInbox(), listNotes({ limit: 8 }), listNotes({ pinned: true, limit: 6 }), listTags(),
  ]);
  return {
    inboxCount: inbox.count, inboxPreview: inbox.items.slice(0, 3),
    daily: daily ? summary(daily) : null, recent: recent.notes, pinned: pinned.notes, resurface,
    stats: { notes: readSQLiteNumber(stats?.notes ?? 0n), links: readSQLiteNumber(stats?.links ?? 0n), tags: tags.length },
  };
}
