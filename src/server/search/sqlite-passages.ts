import type { SearchHit } from "@/lib/types";
import { excerpt } from "@/lib/wikilinks";
import { sqliteStore } from "@/server/db/backend";
import { readSQLiteStringArray } from "@/server/db/sqlite/values";
import { EmbeddingUnavailable, learnedEmbeddings, queryInput, semanticConfigured, SEMANTIC_MODEL_ID } from "./learned";
import { sqliteSourceHash } from "./sqlite-indexer";
import type { SemanticStatus } from "./passages";

export async function searchSQLitePassages(text: string, tag: string | undefined, limit: number): Promise<{
  hits: SearchHit[]; status: SemanticStatus;
}> {
  const store = await sqliteStore();
  const totalNotes = Number(store.get<{ count: bigint }>(
    "SELECT count(*) AS count FROM notes WHERE deleted_at IS NULL AND status<>'archived'",
  )?.count ?? 0n);
  if (!semanticConfigured()) return { hits: [], status: { state: "disabled", indexedNotes: 0, totalNotes } };
  let indexedNotes = 0;
  let noteCursor = "";
  for (;;) {
    const notes = store.all<{ id: string; title: string; body: string; complete: bigint | null; source_hash: string | null }>(
      `SELECT n.id,n.title,n.body,i.complete,i.source_hash FROM notes n LEFT JOIN note_semantic_index i
       ON i.note_id=n.id AND i.model_id=? WHERE n.deleted_at IS NULL AND n.status<>'archived'
       AND n.id>? ORDER BY n.id LIMIT 100`, [SEMANTIC_MODEL_ID, noteCursor],
    );
    if (!notes.length) break;
    for (const row of notes) {
      noteCursor = row.id;
      if (row.complete === 1n && row.source_hash === sqliteSourceHash(row.title, row.body)) indexedNotes++;
    }
  }
  let vector: number[] | undefined;
  try { [vector] = await learnedEmbeddings([queryInput(text)], 1500); }
  catch (error) {
    if (error instanceof EmbeddingUnavailable) return { hits: [], status: { state: "unavailable", indexedNotes, totalNotes } };
    throw error;
  }
  if (!vector) return { hits: [], status: { state: "unavailable", indexedNotes, totalNotes } };
  type Row = { id: string; title: string; body: string; tags: string; updated_at: string;
    content: string; heading: string; start_line: bigint; end_line: bigint; embedding: string; source_hash: string };
  const best = new Map<string, SearchHit>();
  let offset = 0;
  for (;;) {
    const rows = store.all<Row>(
      `SELECT n.id,n.title,n.body,n.tags,n.updated_at,p.content,p.heading,p.start_line,p.end_line,p.embedding,p.source_hash
       FROM note_passages p JOIN notes n ON n.id=p.note_id WHERE p.model_id=?
       AND n.deleted_at IS NULL AND n.status<>'archived' ORDER BY n.id,p.ordinal LIMIT 100 OFFSET ?`,
      [SEMANTIC_MODEL_ID, offset],
    );
    if (!rows.length) break;
    offset += rows.length;
    for (const row of rows) {
      if (row.source_hash !== sqliteSourceHash(row.title, row.body)) continue;
      const tags = readSQLiteStringArray(row.tags);
      if (tag && !tags.some(value => value.toLowerCase() === tag)) continue;
      const values: number[] = JSON.parse(row.embedding);
      const norm = Math.hypot(...values);
      if (!norm) continue;
      const score = values.reduce((sum, value, index) => sum + value * (vector?.[index] ?? 0), 0) / norm;
      if ((best.get(row.id)?.score ?? -Infinity) >= score) continue;
      best.set(row.id, {
        noteId: row.id, title: row.title, tags, updatedAt: new Date(row.updated_at).toISOString(),
        snippet: excerpt(row.content, 220), score, matchedBy: ["learned"],
        passage: { heading: row.heading, startLine: Number(row.start_line), endLine: Number(row.end_line) },
      });
    }
    if (best.size > limit) {
      const keep = new Set([...best.values()]
        .sort((a, b) => b.score - a.score || a.noteId.localeCompare(b.noteId))
        .slice(0, limit).map(hit => hit.noteId));
      for (const id of best.keys()) if (!keep.has(id)) best.delete(id);
    }
  }
  return {
    hits: [...best.values()].sort((a, b) => b.score - a.score || a.noteId.localeCompare(b.noteId)).slice(0, limit),
    status: { state: indexedNotes < totalNotes ? "indexing" : "ready", indexedNotes, totalNotes },
  };
}
