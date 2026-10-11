import type { RelatedNote, SearchHit, SearchMatch, SearchResponse } from "@/lib/types";
import { embedText, tokenize, vectorLiteral } from "@/lib/embed";
import { excerpt, markdownToText, normalizeTag } from "@/lib/wikilinks";
import { query } from "@/server/db";
import { databaseBackend } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { notesCopy, searchCopy } from "@/server/i18n/copy";
import { indexStatus, relatedPassages, retrievePassages, type PassageCandidate } from "./passages";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const EMBEDDING_BATCH_SIZE = 32;
const RRF_K = 60;
const NGRAM_SEARCH_FLOOR = 0.18;
const RELATED_FLOOR = 0.08;

type NoteRow = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  updated_at: Date | string;
  rank_score: number | string;
};

type PendingEmbeddingRow = {
  id: string;
  title: string;
  body: string;
  source_hash: string;
};

type RelatedRow = {
  id: string;
  title: string;
  body: string;
  score: number | string;
};

type RankedCandidate = {
  row: NoteRow;
  score: number;
  ranks: Map<SearchMatch, number>;
  passage?: PassageCandidate;
};

function validatedLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new ApiError("validation", searchCopy.limit(MAX_LIMIT));
  }
  return value;
}

function validatedTag(tag: string | undefined): string | undefined {
  if (tag === undefined) return undefined;
  const value = normalizeTag(tag);
  if (!value || value.length > 100) {
    throw new ApiError("validation", searchCopy.tagLength);
  }
  return value;
}

function activeFilter(tag: string | undefined, tagParameter: number): string {
  const tagSql = tag
    ? ` AND EXISTS (SELECT 1 FROM unnest(tags) AS note_tag WHERE lower(note_tag) = $${tagParameter})`
    : "";
  return `deleted_at IS NULL AND status <> 'archived'${tagSql}`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function snippet(body: string, searchQuery: string): string {
  const text = markdownToText(body);
  if (!text) return "";

  const normalized = text.toLocaleLowerCase();
  const terms = tokenize(searchQuery);
  let matchAt = -1;
  for (const term of terms) {
    const at = normalized.indexOf(term);
    if (at >= 0 && (matchAt < 0 || at < matchAt)) matchAt = at;
  }
  if (matchAt < 0) return excerpt(body, 220);

  const start = Math.max(0, matchAt - 70);
  const end = Math.min(text.length, start + 218);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Refresh a small, bounded set while never serving an embedding for stale note text. */
async function backfillEmbeddings(preferredNoteId?: string): Promise<void> {
  const rows = await query<PendingEmbeddingRow>(
    `SELECT id::text, title, body,
            md5(coalesce(title, '') || E'\\n' || coalesce(body, '')) AS source_hash
       FROM notes
      WHERE deleted_at IS NULL
        AND status <> 'archived'
        AND (search_embedding IS NULL OR search_source_hash IS DISTINCT FROM
             md5(coalesce(title, '') || E'\\n' || coalesce(body, '')))
      ORDER BY CASE WHEN id::text = $2 THEN 0 ELSE 1 END, updated_at DESC, id
      LIMIT $1`,
    [EMBEDDING_BATCH_SIZE, preferredNoteId ?? ""],
  );

  await Promise.all(rows.map((row) => query(
    `UPDATE notes
        SET search_embedding = $2::vector,
            search_embedded_at = now(),
            search_source_hash = $3
      WHERE id = $1
        AND deleted_at IS NULL
        AND status <> 'archived'
        AND md5(coalesce(title, '') || E'\\n' || coalesce(body, '')) = $3`,
    [row.id, vectorLiteral(embedText(`${row.title}\n${row.body}`)), row.source_hash],
  )));
}

function addRanking(
  candidates: Map<string, RankedCandidate>,
  rows: NoteRow[],
  signal: SearchMatch,
): void {
  rows.forEach((row, index) => {
    const candidate = candidates.get(row.id) ?? { row, score: 0, ranks: new Map() };
    candidate.ranks.set(signal, index + 1);
    candidate.score += 1 / (RRF_K + index + 1);
    candidates.set(row.id, candidate);
  });
}

export async function searchNotes(
  queryText: string,
  options: { tag?: string; limit?: number } = {},
): Promise<SearchResponse> {
  const startedAt = performance.now();
  const queryTextTrimmed = queryText.trim();
  const limit = validatedLimit(options.limit);
  const tag = validatedTag(options.tag);
  if (!queryTextTrimmed) return { query: queryText, hits: [], tookMs: Math.max(0, performance.now() - startedAt) };
  if (databaseBackend() === "sqlite") {
    const { searchSQLite } = await import("./sqlite");
    return searchSQLite(queryText, tag, limit);
  }

  await backfillEmbeddings();
  const shortlistLimit = Math.min(MAX_LIMIT, Math.max(limit * 4, 20));
  const params: unknown[] = [queryTextTrimmed];
  if (tag) params.push(tag);
  params.push(shortlistLimit);
  const limitParameter = params.length;
  const filter = activeFilter(tag, 2);
  const hasTerms = tokenize(queryTextTrimmed).length > 0;

  const keywordPromise = query<NoteRow>(
    `SELECT id::text, title, body, tags, updated_at,
            ts_rank_cd(search_tsv, plainto_tsquery('simple', $1)) AS rank_score
       FROM notes
      WHERE ${filter}
        AND search_tsv @@ plainto_tsquery('simple', $1)
      ORDER BY rank_score DESC, updated_at DESC, id
      LIMIT $${limitParameter}`,
    params,
  );
  const fuzzyPromise = query<NoteRow>(
    `SELECT id::text, title, body, tags, updated_at,
            CASE WHEN lower(title)=lower($1) OR EXISTS(SELECT 1 FROM unnest(aliases) a WHERE lower(a)=lower($1)) THEN 4
                 WHEN strpos(lower(title || E'\\n' || body || E'\\n' || array_to_string(aliases,' ') || E'\\n' || array_to_string(tags,' ')), lower($1)) > 0 THEN 2 ELSE 0 END
            + greatest(similarity(lower(title), lower($1)),
                       word_similarity(lower($1), lower(left(body, 10000)))) AS rank_score
       FROM notes
      WHERE ${filter}
        AND (strpos(lower(title || E'\\n' || body || E'\\n' || array_to_string(aliases,' ') || E'\\n' || array_to_string(tags,' ')), lower($1)) > 0
             OR similarity(lower(title), lower($1)) >= 0.2
             OR word_similarity(lower($1), lower(left(body, 10000))) >= 0.3)
      ORDER BY rank_score DESC, updated_at DESC, id
      LIMIT $${limitParameter}`,
    params,
  );
  const ngramPromise = hasTerms
    ? query<NoteRow>(
      `SELECT id::text, title, body, tags, updated_at,
              1 - (search_embedding <=> $1::vector) AS rank_score
         FROM notes
        WHERE ${activeFilter(tag, 3)}
          AND search_embedding IS NOT NULL
          AND search_source_hash = md5(coalesce(title, '') || E'\\n' || coalesce(body, ''))
          AND 1 - (search_embedding <=> $1::vector) >= $2
        ORDER BY search_embedding <=> $1::vector, updated_at DESC, id
        LIMIT $${tag ? 4 : 3}`,
      tag
        ? [vectorLiteral(embedText(queryTextTrimmed)), NGRAM_SEARCH_FLOOR, tag, shortlistLimit]
        : [vectorLiteral(embedText(queryTextTrimmed)), NGRAM_SEARCH_FLOOR, shortlistLimit],
    )
    : Promise.resolve([]);

  const [keyword, fuzzy, ngram, learned] = await Promise.all([
    keywordPromise, fuzzyPromise, ngramPromise, retrievePassages(queryTextTrimmed, tag, shortlistLimit),
  ]);
  const semanticIndex = await indexStatus(learned.available);
  const candidates = new Map<string, RankedCandidate>();
  addRanking(candidates, keyword, "keyword");
  addRanking(candidates, fuzzy, "fuzzy");
  const latinGrams = new Set<string>();
  const otherGrams = new Set<string>();
  for (const token of tokenize(queryTextTrimmed)) {
    for (const [part] of token.matchAll(/[\p{Script=Latin}\p{N}]+|[^\p{Script=Latin}\p{N}]+/gu)) {
      const latin = /\p{Script=Latin}/u.test(part);
      const chars = Array.from(part);
      const size = Math.min(chars.length, latin ? 3 : 2);
      const grams = latin ? latinGrams : otherGrams;
      for (let index = 0; index <= chars.length - size; index += 1) {
        grams.add(chars.slice(index, index + size).join(""));
      }
    }
  }
  // Hash similarity needs actual text evidence. Latin bigrams are too common:
  // require at least half of distinct trigrams, retaining non-Latin overlap
  // and whole terms shorter than a gram within the existing bounded window.
  // A ready learned index replaces the approximate hash lane, not lexical search.
  if (semanticIndex.state !== "ready") addRanking(candidates, ngram.filter((row) => {
    const text = `${row.title}\n${row.body.slice(0, 10000)}`.toLowerCase().normalize("NFKC");
    const matchedLatin = [...latinGrams].filter((gram) => text.includes(gram)).length;
    return [...otherGrams].some((gram) => text.includes(gram))
      || (latinGrams.size > 0 && matchedLatin * 2 >= latinGrams.size);
  }), "semantic");
  addRanking(candidates, learned.rows, "learned");
  for (const row of learned.rows) {
    const candidate = candidates.get(row.id);
    if (candidate) candidate.passage = row;
  }
  const exactIds = new Set(fuzzy.filter((row) => Number(row.rank_score) >= 4).map((row) => row.id));

  const hits: SearchHit[] = [...candidates.values()]
    .sort((a, b) => Number(exactIds.has(b.row.id)) - Number(exactIds.has(a.row.id)) || b.score - a.score
      || Number(b.row.rank_score) - Number(a.row.rank_score)
      || b.row.updated_at.toString().localeCompare(a.row.updated_at.toString())
      || a.row.id.localeCompare(b.row.id))
    .slice(0, limit)
    .map(({ row, score, ranks, passage }) => ({
      noteId: row.id,
      title: row.title,
      snippet: snippet(passage?.body ?? row.body, queryTextTrimmed),
      tags: row.tags,
      updatedAt: iso(row.updated_at),
      score,
      matchedBy: (["keyword", "fuzzy", "semantic", "learned"] as const).filter((signal) => ranks.has(signal)),
      ...(passage ? { passage: { heading: passage.heading, startLine: passage.start_line, endLine: passage.end_line } } : {}),
    }));

  return { query: queryText, hits, tookMs: Math.max(0, performance.now() - startedAt), semanticIndex };
}

export async function relatedNotes(noteId: string, limitValue?: number): Promise<RelatedNote[]> {
  const limit = validatedLimit(limitValue);
  if (databaseBackend() === "sqlite") {
    const { relatedSQLite } = await import("./sqlite");
    return relatedSQLite(noteId, limit);
  }
  const learned = await relatedPassages(noteId, limit);
  if (learned.length) return learned.map((row) => ({
    id: row.id, title: row.title, excerpt: excerpt(row.body), score: Number(row.rank_score),
    matchedBy: ["learned"], updatedAt: iso(row.updated_at),
    passage: { heading: row.heading, startLine: row.start_line, endLine: row.end_line },
  }));
  await backfillEmbeddings(noteId);
  const source = await query<{ embedding: string }>(
    `SELECT search_embedding::text AS embedding
       FROM notes
      WHERE id::text = $1
        AND deleted_at IS NULL
        AND status <> 'archived'
        AND search_embedding IS NOT NULL
        AND search_source_hash = md5(coalesce(title, '') || E'\\n' || coalesce(body, ''))`,
    [noteId],
  );
  const embedding = source[0]?.embedding;
  if (!embedding) throw new ApiError("not_found", notesCopy.notFound);

  const rows = await query<RelatedRow>(
    `SELECT id::text, title, body, 1 - (search_embedding <=> $1::vector) AS score
       FROM notes
      WHERE id::text <> $2
        AND deleted_at IS NULL
        AND status <> 'archived'
        AND search_embedding IS NOT NULL
        AND search_source_hash = md5(coalesce(title, '') || E'\\n' || coalesce(body, ''))
        AND 1 - (search_embedding <=> $1::vector) >= $3
      ORDER BY search_embedding <=> $1::vector, updated_at DESC, id
      LIMIT $4`,
    [embedding, noteId, RELATED_FLOOR, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    excerpt: excerpt(row.body),
    score: Number(row.score),
    matchedBy: ["semantic"],
  }));
}
