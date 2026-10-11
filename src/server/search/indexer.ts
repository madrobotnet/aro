import { query, tx } from "@/server/db";
import { databaseBackend } from "@/server/db/backend";
import { chunkMarkdown } from "./chunks";
import { documentInput, learnedEmbeddings, semanticConfigured, SEMANTIC_MODEL_ID } from "./learned";

const SOURCE_HASH = "md5(n.title || E'\\n' || n.body)";
const BATCH_SIZE = 1;

/** One passage per invocation leaves gaps for queries; progress survives restarts. */
export async function runSemanticIndexBatch(): Promise<number> {
  if (!semanticConfigured()) return 0;
  if (databaseBackend() === "sqlite") return (await import("./sqlite-indexer")).runSQLiteSemanticBatch();
  const rows = await query<{ id: string; title: string; body: string; source_hash: string }>(
    `SELECT n.id::text, n.title, n.body, ${SOURCE_HASH} AS source_hash
       FROM notes n LEFT JOIN note_semantic_index i ON i.note_id=n.id AND i.model_id=$1
      WHERE n.deleted_at IS NULL AND n.status <> 'archived'
        AND (i.source_hash IS DISTINCT FROM ${SOURCE_HASH} OR NOT i.complete)
      ORDER BY i.updated_at NULLS FIRST, n.updated_at, n.id LIMIT 1`,
    [SEMANTIC_MODEL_ID],
  );
  const note = rows[0];
  if (!note) return 0;
  const chunks = chunkMarkdown(note.body);
  if (!chunks.length) chunks.push({ ordinal: 0, heading: "", startLine: 1, endLine: 1, content: "" });
  const existing = await query<{ ordinal: number }>(
    "SELECT ordinal FROM note_passages WHERE note_id=$1 AND model_id=$2 AND source_hash=$3",
    [note.id, SEMANTIC_MODEL_ID, note.source_hash],
  );
  const done = new Set(existing.map((row) => row.ordinal));
  const pending = chunks.filter((chunk) => !done.has(chunk.ordinal)).slice(0, BATCH_SIZE);
  const vectors = pending.length
    ? await learnedEmbeddings(pending.map((chunk) => documentInput(note.title, chunk.heading, chunk.content)))
    : [];
  return tx(async (client) => {
    // Lock only after inference. Recheck content and visibility so racing edits never publish stale evidence.
    const current = await client.query<{ fresh: boolean }>(
      `SELECT md5(title || E'\\n' || body)=$2 AND deleted_at IS NULL AND status <> 'archived' AS fresh
         FROM notes WHERE id=$1 FOR UPDATE`,
      [note.id, note.source_hash],
    );
    if (!current.rows[0]?.fresh) return 0;
    await client.query(
      "DELETE FROM note_passages WHERE note_id=$1 AND model_id=$2 AND source_hash<>$3",
      [note.id, SEMANTIC_MODEL_ID, note.source_hash],
    );
    for (const [index, chunk] of pending.entries()) {
      const vector = vectors[index];
      if (!vector) continue;
      await client.query(
        `INSERT INTO note_passages(note_id,model_id,source_hash,ordinal,heading,start_line,end_line,content,embedding)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)
         ON CONFLICT(note_id,model_id,ordinal) DO UPDATE SET
           source_hash=excluded.source_hash,heading=excluded.heading,start_line=excluded.start_line,
           end_line=excluded.end_line,content=excluded.content,embedding=excluded.embedding`,
        [note.id, SEMANTIC_MODEL_ID, note.source_hash, chunk.ordinal, chunk.heading,
          chunk.startLine, chunk.endLine, chunk.content, JSON.stringify(vector)],
      );
    }
    await client.query(
      `INSERT INTO note_semantic_index(note_id,model_id,source_hash,complete)
       VALUES($1,$2,$3,(SELECT count(*)=$4 FROM note_passages WHERE note_id=$1 AND model_id=$2 AND source_hash=$3))
       ON CONFLICT(note_id,model_id) DO UPDATE SET source_hash=excluded.source_hash,
         complete=excluded.complete,updated_at=now()`,
      [note.id, SEMANTIC_MODEL_ID, note.source_hash, chunks.length],
    );
    return pending.length;
  });
}

export function startSemanticIndexing(): () => void {
  if (!semanticConfigured()) return () => {};
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runSemanticIndexBatch()
      .catch(() => console.warn("[semantic-index] indexing deferred"))
      .finally(() => { running = false; });
  };
  tick();
  const timer = setInterval(tick, 3000);
  timer.unref();
  return () => clearInterval(timer);
}
