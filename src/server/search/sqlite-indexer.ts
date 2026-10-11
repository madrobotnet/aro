import { createHash } from "node:crypto";
import { sqliteStore } from "@/server/db/backend";
import { sqliteTimestamp } from "@/server/db/sqlite/values";
import { chunkMarkdown } from "./chunks";
import { documentInput, learnedEmbeddings, SEMANTIC_MODEL_ID } from "./learned";

export const sqliteSourceHash = (title: string, body: string): string =>
  createHash("md5").update(`${title}\n${body}`).digest("hex");

/** Inference happens outside the writer; only a still-current source may commit. */
export async function runSQLiteSemanticBatch(): Promise<number> {
  const store = await sqliteStore();
  type PendingNote = { id: string; title: string; body: string; source_hash: string | null; complete: bigint | null };
  let note: PendingNote | undefined;
  let cursor = "";
  while (!note) {
    const rows = store.all<PendingNote>(
      `SELECT n.id,n.title,n.body,i.source_hash,i.complete FROM notes n
       LEFT JOIN note_semantic_index i ON i.note_id=n.id AND i.model_id=?
       WHERE n.deleted_at IS NULL AND n.status<>'archived' AND n.id>? ORDER BY n.id LIMIT 100`,
      [SEMANTIC_MODEL_ID, cursor],
    );
    if (!rows.length) break;
    note = rows.find(row => row.complete !== 1n || row.source_hash !== sqliteSourceHash(row.title, row.body));
    cursor = rows[rows.length - 1]!.id;
  }
  if (!note) return 0;
  const hash = sqliteSourceHash(note.title, note.body);
  const chunks = chunkMarkdown(note.body);
  if (!chunks.length) chunks.push({ ordinal: 0, heading: "", startLine: 1, endLine: 1, content: "" });
  const done = new Set(store.all<{ ordinal: bigint }>(
    "SELECT ordinal FROM note_passages WHERE note_id=? AND model_id=? AND source_hash=?",
    [note.id, SEMANTIC_MODEL_ID, hash],
  ).map(row => Number(row.ordinal)));
  const pending = chunks.filter(chunk => !done.has(chunk.ordinal)).slice(0, 1);
  const vectors = pending.length
    ? await learnedEmbeddings(pending.map(chunk => documentInput(note.title, chunk.heading, chunk.content))) : [];
  return store.transaction(q => {
    const current = q.get<{ title: string; body: string }>(
      "SELECT title,body FROM notes WHERE id=? AND deleted_at IS NULL AND status<>'archived'", [note.id],
    );
    if (!current || sqliteSourceHash(current.title, current.body) !== hash) return 0;
    q.run("DELETE FROM note_passages WHERE note_id=? AND model_id=? AND source_hash<>?", [note.id, SEMANTIC_MODEL_ID, hash]);
    for (const [index, chunk] of pending.entries()) {
      const vector = vectors[index];
      if (!vector) continue;
      q.run(
        `INSERT INTO note_passages(note_id,model_id,source_hash,ordinal,heading,start_line,end_line,content,embedding)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(note_id,model_id,ordinal) DO UPDATE SET
         source_hash=excluded.source_hash,heading=excluded.heading,start_line=excluded.start_line,
         end_line=excluded.end_line,content=excluded.content,embedding=excluded.embedding`,
        [note.id, SEMANTIC_MODEL_ID, hash, chunk.ordinal, chunk.heading, chunk.startLine, chunk.endLine,
          chunk.content, JSON.stringify(vector)],
      );
    }
    const count = q.get<{ count: bigint }>(
      "SELECT count(*) AS count FROM note_passages WHERE note_id=? AND model_id=? AND source_hash=?",
      [note.id, SEMANTIC_MODEL_ID, hash],
    )?.count ?? 0n;
    q.run(
      `INSERT INTO note_semantic_index(note_id,model_id,source_hash,complete,updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(note_id,model_id) DO UPDATE SET source_hash=excluded.source_hash,
       complete=excluded.complete,updated_at=excluded.updated_at`,
      [note.id, SEMANTIC_MODEL_ID, hash, Number(count === BigInt(chunks.length)), sqliteTimestamp(new Date())],
    );
    return pending.length;
  });
}
