import type { HomeData, NoteSummary } from "@/lib/types";
import { excerpt } from "@/lib/wikilinks";
import { query } from "@/server/db";
import { databaseBackend } from "@/server/db/backend";
import { listInbox } from "@/server/inbox";
import { listNotes, listTags } from "@/server/notes/service";

type NoteRow = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  status: string;
  daily_date: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type HomeOptions = {
  now?: Date;
  timeZone?: string;
};

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function dateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function mapSummary(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    excerpt: excerpt(row.body),
    tags: row.tags,
    pinned: row.pinned,
    archived: row.status === "archived",
    dailyDate: dateOnly(row.daily_date),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** YYYY-MM-DD in the supplied IANA zone, or the server's local zone when omitted. */
export function homeDate(now = new Date(), timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Build the authenticated dashboard snapshot. Resurfacing is stable for one local calendar day. */
export async function getHomeData(options: HomeOptions = {}): Promise<HomeData> {
  const today = homeDate(options.now, options.timeZone);
  if (databaseBackend() === "sqlite") return (await import("./sqlite")).homeSQLite(today);
  const [inbox, recent, pinned, dailyRows, resurfaceRows, statsRows, tags] = await Promise.all([
    listInbox(),
    listNotes({ limit: 8 }),
    listNotes({ pinned: true, limit: 6 }),
    query<NoteRow>(
      `SELECT id,title,body,tags,pinned,status,daily_date,created_at,updated_at
         FROM notes
        WHERE daily_date=$1::date AND deleted_at IS NULL
        LIMIT 1`,
      [today],
    ),
    query<NoteRow>(
      `SELECT id,title,body,tags,pinned,status,daily_date,created_at,updated_at
         FROM notes
        WHERE deleted_at IS NULL
          AND status<>'archived'
          AND updated_at < $1::date - interval '14 days'
        ORDER BY md5(id::text || ':' || $1), id
        LIMIT 3`,
      [today],
    ),
    query<{ notes: number; links: number }>(
      `SELECT
         (SELECT count(*)::int FROM notes WHERE deleted_at IS NULL) AS notes,
         (SELECT count(*)::int
            FROM links l
            JOIN notes source ON source.id=l.from_note_id AND source.deleted_at IS NULL
            JOIN notes target ON target.id=l.to_note_id AND target.deleted_at IS NULL) AS links`,
    ),
    listTags(),
  ]);

  return {
    inboxCount: inbox.count,
    inboxPreview: inbox.items.slice(0, 3),
    daily: dailyRows[0] ? mapSummary(dailyRows[0]) : null,
    pinned: pinned.notes,
    recent: recent.notes,
    resurface: resurfaceRows.map(mapSummary),
    stats: {
      notes: statsRows[0]?.notes ?? 0,
      links: statsRows[0]?.links ?? 0,
      tags: tags.length,
    },
  };
}
