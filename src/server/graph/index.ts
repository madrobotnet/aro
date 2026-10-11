import type { GraphData, GraphLink, GraphNode } from "@/lib/types";
import { normalizeTag } from "@/lib/wikilinks";
import { query, queryOne } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { readSQLiteStringArray, readSQLiteNumber } from "@/server/db/sqlite/values";
import { ApiError } from "@/server/http";
import { graphCopy } from "@/server/i18n/copy";

export const GRAPH_NODE_LIMIT = 2_000;

export type GraphOptions = {
  focusId?: string;
  depth?: 1 | 2 | 3;
  includeTags?: boolean;
  includeOrphans?: boolean;
  tag?: string;
};

type NoteRow = {
  id: string;
  title: string;
  tags: string[];
  updated_at: Date;
  distance?: number;
};

type ResolvedRow = { source: string; target: string };
type UnresolvedRow = { source: string; target_title: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseGraphQuery(url: URL): GraphOptions {
  const focus = url.searchParams.get("focus");
  if (focus !== null && !UUID_RE.test(focus)) {
    throw new ApiError("validation", graphCopy.focusUuid);
  }

  const depthValue = url.searchParams.get("depth");
  if (depthValue !== null && !/^[123]$/.test(depthValue)) {
    throw new ApiError("validation", graphCopy.depth);
  }

  const parseFlag = (name: "tags" | "orphans", fallback: boolean): boolean => {
    const value = url.searchParams.get(name);
    if (value === null) return fallback;
    if (value !== "0" && value !== "1") {
      throw new ApiError("validation", graphCopy.flag(name));
    }
    return value === "1";
  };

  const rawTag = url.searchParams.get("tag");
  const tag = rawTag === null ? undefined : normalizeTag(rawTag);
  if (rawTag !== null && !tag) throw new ApiError("validation", graphCopy.tagEmpty);

  return {
    ...(focus ? { focusId: focus } : {}),
    ...(depthValue ? { depth: Number(depthValue) as 1 | 2 | 3 } : {}),
    includeTags: parseFlag("tags", false),
    includeOrphans: parseFlag("orphans", true),
    ...(tag ? { tag } : {}),
  };
}

async function loadNotes(options: GraphOptions): Promise<NoteRow[]> {
  const tag = options.tag ? normalizeTag(options.tag) : null;
  if (databaseBackend() === "sqlite") {
    const store = await sqliteStore();
    type SQLiteNote = { id: string; title: string; tags: string; updated_at: string; distance?: bigint };
    let rows: SQLiteNote[];
    if (options.focusId) {
      const focus = options.focusId.toLowerCase();
      if (!store.get("SELECT id FROM notes WHERE id=? AND deleted_at IS NULL AND status<>'archived'", [focus])) {
        throw new ApiError("not_found", graphCopy.focusMissing);
      }
      rows = store.all<SQLiteNote>(
        `WITH RECURSIVE walk(id,distance) AS (
          SELECT ?,0 UNION
          SELECT CASE WHEN l.from_note_id=walk.id THEN l.to_note_id ELSE l.from_note_id END,walk.distance+1
          FROM walk JOIN links l ON l.from_note_id=walk.id OR l.to_note_id=walk.id
          JOIN notes n ON n.id=CASE WHEN l.from_note_id=walk.id THEN l.to_note_id ELSE l.from_note_id END
          WHERE walk.distance<? AND n.deleted_at IS NULL AND n.status<>'archived'
            AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(n.tags) WHERE value=?))
        ), nearest AS (SELECT id,min(distance) AS distance FROM walk GROUP BY id)
        SELECT n.id,n.title,n.tags,n.updated_at,nearest.distance FROM nearest JOIN notes n ON n.id=nearest.id
        ORDER BY nearest.distance,lower(n.title),n.id LIMIT ?`,
        [focus, options.depth ?? 1, tag, tag, GRAPH_NODE_LIMIT + 1],
      );
    } else {
      rows = store.all<SQLiteNote>(
        `SELECT id,title,tags,updated_at FROM notes WHERE deleted_at IS NULL AND status<>'archived'
         AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(notes.tags) WHERE value=?))
         ORDER BY lower(title),id LIMIT ?`, [tag, tag, GRAPH_NODE_LIMIT + 1],
      );
    }
    return rows.map(row => ({ id: row.id, title: row.title, tags: readSQLiteStringArray(row.tags), updated_at: new Date(row.updated_at),
      ...(row.distance === undefined ? {} : { distance: readSQLiteNumber(row.distance) }) }));
  }
  if (!options.focusId) {
    return query<NoteRow>(
      `SELECT id, title, tags, updated_at
         FROM notes
        WHERE deleted_at IS NULL
          AND status <> 'archived'
          AND ($1::text IS NULL OR $1 = ANY(tags))
        ORDER BY lower(title), id
        LIMIT $2`,
      [tag, GRAPH_NODE_LIMIT + 1],
    );
  }

  const focus = await queryOne<{ id: string }>(
    "SELECT id FROM notes WHERE id = $1 AND deleted_at IS NULL AND status <> 'archived'",
    [options.focusId],
  );
  if (!focus) throw new ApiError("not_found", graphCopy.focusMissing);

  return query<NoteRow>(
    `WITH RECURSIVE walk(id, distance) AS (
       SELECT $1::uuid, 0
       UNION
       SELECT CASE WHEN l.from_note_id = walk.id THEN l.to_note_id ELSE l.from_note_id END,
              walk.distance + 1
         FROM walk
         JOIN links l ON l.from_note_id = walk.id OR l.to_note_id = walk.id
         JOIN notes neighbor
           ON neighbor.id = CASE WHEN l.from_note_id = walk.id THEN l.to_note_id ELSE l.from_note_id END
          AND neighbor.deleted_at IS NULL
          AND neighbor.status <> 'archived'
          AND ($3::text IS NULL OR $3 = ANY(neighbor.tags))
        WHERE walk.distance < $2
     ), nearest AS (
       SELECT id, min(distance) AS distance FROM walk GROUP BY id
     )
     SELECT n.id, n.title, n.tags, n.updated_at, nearest.distance
       FROM nearest
       JOIN notes n ON n.id = nearest.id
      ORDER BY nearest.distance, lower(n.title), n.id
      LIMIT $4`,
    [options.focusId, options.depth ?? 1, tag, GRAPH_NODE_LIMIT + 1],
  );
}

function compareLinks(a: GraphLink, b: GraphLink): number {
  return a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind);
}

/** Build a deterministic active-note graph. The returned node set never exceeds 2,000. */
export async function getGraph(options: GraphOptions = {}): Promise<GraphData> {
  const loaded = await loadNotes(options);
  let truncated = loaded.length > GRAPH_NODE_LIMIT;
  const notes = loaded.slice(0, GRAPH_NODE_LIMIT);
  const noteIds = notes.map((note) => note.id);

  if (noteIds.length === 0) {
    return { nodes: [], links: [], focusId: options.focusId ?? null, truncated };
  }

  const native = databaseBackend() === "sqlite" ? await sqliteStore() : null;
  const [resolved, unresolved] = native ? [
    native.all<ResolvedRow>(
      "SELECT from_note_id AS source,to_note_id AS target FROM links WHERE from_note_id IN (SELECT value FROM json_each(?)) AND to_note_id IN (SELECT value FROM json_each(?)) ORDER BY from_note_id,to_note_id",
      [JSON.stringify(noteIds), JSON.stringify(noteIds)],
    ),
    native.all<UnresolvedRow>(
      "SELECT from_note_id AS source,target_title FROM unresolved_links WHERE from_note_id IN (SELECT value FROM json_each(?)) ORDER BY from_note_id,lower(target_title),target_title",
      [JSON.stringify(noteIds)],
    ),
  ] : await Promise.all([
    query<ResolvedRow>(
      `SELECT l.from_note_id AS source, l.to_note_id AS target
         FROM links l
         JOIN notes source ON source.id = l.from_note_id
         JOIN notes target ON target.id = l.to_note_id
        WHERE l.from_note_id = ANY($1::uuid[])
          AND l.to_note_id = ANY($1::uuid[])
          AND source.deleted_at IS NULL AND source.status <> 'archived'
          AND target.deleted_at IS NULL AND target.status <> 'archived'
        ORDER BY l.from_note_id, l.to_note_id`,
      [noteIds],
    ),
    query<UnresolvedRow>(
      `SELECT u.from_note_id AS source, u.target_title
         FROM unresolved_links u
        WHERE u.from_note_id = ANY($1::uuid[])
        ORDER BY u.from_note_id, lower(u.target_title), u.target_title`,
      [noteIds],
    ),
  ]);

  const extraNodes = new Map<string, GraphNode>();
  for (const row of unresolved) {
    const id = `ghost:${row.target_title.trim().toLowerCase()}`;
    const existing = extraNodes.get(id);
    if (!existing || row.target_title.localeCompare(existing.label) < 0) {
      extraNodes.set(id, { id, kind: "unresolved", label: row.target_title, tags: [], degree: 0, updatedAt: null });
    }
  }
  if (options.includeTags) {
    for (const note of notes) {
      for (const tag of note.tags) {
        const id = `tag:${tag}`;
        extraNodes.set(id, { id, kind: "tag", label: tag, tags: [], degree: 0, updatedAt: null });
      }
    }
  }

  const allowedExtras = new Set<string>();
  for (const id of [...extraNodes.keys()].sort()) {
    if (notes.length + allowedExtras.size >= GRAPH_NODE_LIMIT) {
      truncated = true;
      break;
    }
    allowedExtras.add(id);
  }

  const links: GraphLink[] = resolved.map((row) => ({ source: row.source, target: row.target, kind: "link" }));
  for (const row of unresolved) {
    const target = `ghost:${row.target_title.trim().toLowerCase()}`;
    if (allowedExtras.has(target)) links.push({ source: row.source, target, kind: "unresolved" });
    else truncated = true;
  }
  if (options.includeTags) {
    for (const note of notes) {
      for (const tag of note.tags) {
        const target = `tag:${tag}`;
        if (allowedExtras.has(target)) links.push({ source: note.id, target, kind: "tag" });
        else truncated = true;
      }
    }
  }

  let visibleNotes = notes;
  if (options.includeOrphans === false) {
    const connected = new Set<string>();
    for (const link of links) {
      if (link.kind === "tag") continue;
      connected.add(link.source);
      if (!link.target.startsWith("ghost:")) connected.add(link.target);
    }
    visibleNotes = notes.filter((note) => connected.has(note.id));
  }

  const visibleIds = new Set(visibleNotes.map((note) => note.id));
  const visibleLinks = links.filter((link) => visibleIds.has(link.source) && (visibleIds.has(link.target) || allowedExtras.has(link.target)));
  const referencedExtras = new Set(visibleLinks.filter((link) => !visibleIds.has(link.target)).map((link) => link.target));
  const degree = new Map<string, number>();
  for (const link of visibleLinks) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = [
    ...visibleNotes.map((note) => ({
      id: note.id,
      kind: "note" as const,
      label: note.title,
      tags: note.tags,
      degree: degree.get(note.id) ?? 0,
      updatedAt: note.updated_at.toISOString(),
    })),
    ...[...referencedExtras].map((id) => ({ ...extraNodes.get(id)!, degree: degree.get(id) ?? 0 })),
  ];

  const kindOrder = { note: 0, tag: 1, unresolved: 2 } as const;
  nodes.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  visibleLinks.sort(compareLinks);
  return { nodes, links: visibleLinks, focusId: options.focusId ?? null, truncated };
}
