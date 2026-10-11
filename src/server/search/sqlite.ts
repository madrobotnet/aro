import type { RelatedNote, SearchResponse } from "@/lib/types";
import { embedText, tokenize } from "@/lib/embed";
import { excerpt, markdownToText, normalizeTitle } from "@/lib/wikilinks";
import { sqliteStore } from "@/server/db/backend";
import { readSQLiteStringArray } from "@/server/db/sqlite/values";
import { ApiError } from "@/server/http";
import { notesCopy } from "@/server/i18n/copy";
import { searchSQLitePassages } from "./sqlite-passages";

type Row = {
  id: string;
  title: string;
  body: string;
  tags: string;
  aliases: string;
  updated_at: string;
};

/** Native lexical retrieval; JavaScript Unicode folding avoids SQLite lower's ASCII limit. */
export async function searchSQLite(text: string, tag: string | undefined, limit: number): Promise<SearchResponse> {
  const started = performance.now();
  const store = await sqliteStore();
  const terms = tokenize(text);
  const normalized = normalizeTitle(text);
  const hits: SearchResponse["hits"] = [];
  let cursor = "";
  for (;;) {
    const rows = store.all<Row>(
      "SELECT id,title,body,tags,aliases,updated_at FROM notes WHERE deleted_at IS NULL AND status<>'archived' AND id>? ORDER BY id LIMIT 100",
      [cursor],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.id;
      const tags = readSQLiteStringArray(row.tags);
      if (tag && !tags.some(value => value.toLowerCase() === tag)) continue;
      const aliases = readSQLiteStringArray(row.aliases);
      const title = normalizeTitle(row.title);
      const plain = markdownToText(row.body);
      const haystack = normalizeTitle(`${row.title}\n${aliases.join("\n")}\n${tags.join(" ")}\n${plain}`);
      const exact = title === normalized || aliases.some(value => normalizeTitle(value) === normalized);
      const matches = terms.filter(term => haystack.includes(term));
      if (!exact && matches.length === 0) continue;
      const score = Number(exact) * 10 + Number(haystack.includes(normalized)) * 2
        + matches.length / Math.max(1, terms.length);
      const positions = matches.map(term => plain.toLowerCase().indexOf(term)).filter(at => at >= 0);
      const at = positions.length ? Math.max(0, Math.min(...positions) - 70) : 0;
      hits.push({
        noteId: row.id, title: row.title, tags, updatedAt: new Date(row.updated_at).toISOString(),
        snippet: at ? `…${plain.slice(at, at + 218)}` : excerpt(row.body, 220),
        score, matchedBy: ["keyword"],
      });
    }
    hits.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.noteId.localeCompare(b.noteId));
    hits.length = Math.min(hits.length, limit);
  }
  const learned = await searchSQLitePassages(text, tag, limit);
  for (const hit of learned.hits) {
    const existing = hits.find(candidate => candidate.noteId === hit.noteId);
    if (existing) {
      existing.matchedBy.push("learned");
      existing.passage = hit.passage;
      existing.score += Math.max(0, hit.score);
    } else hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.noteId.localeCompare(b.noteId));
  return { query: text, hits: hits.slice(0, limit), tookMs: Math.max(0, performance.now() - started),
    semanticIndex: learned.status };
}

/** Existing deterministic character-similarity fallback, not learned semantics. */
export async function relatedSQLite(noteId: string, limit: number): Promise<RelatedNote[]> {
  const store = await sqliteStore();
  const source = store.get<Row>(
    "SELECT id,title,body,tags,aliases,updated_at FROM notes WHERE id=? AND deleted_at IS NULL AND status<>'archived'",
    [noteId.toLowerCase()],
  );
  if (!source) throw new ApiError("not_found", notesCopy.notFound);
  const vector = embedText(`${source.title}\n${source.body}`);
  const related: RelatedNote[] = [];
  let cursor = "";
  for (;;) {
    const rows = store.all<Row>(
      "SELECT id,title,body,tags,aliases,updated_at FROM notes WHERE id<>? AND id>? AND deleted_at IS NULL AND status<>'archived' ORDER BY id LIMIT 100",
      [source.id, cursor],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.id;
      const other = embedText(`${row.title}\n${row.body}`);
      const score = vector.reduce((sum, value, index) => sum + value * (other[index] ?? 0), 0);
      if (score < 0.08) continue;
      related.push({ id: row.id, title: row.title, excerpt: excerpt(row.body), score, matchedBy: ["semantic"] });
    }
    related.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    related.length = Math.min(related.length, limit);
  }
  return related;
}
