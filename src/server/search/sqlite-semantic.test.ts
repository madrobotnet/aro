import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore, sqliteStore } from "@/server/db/backend";
import { createNote, updateNote } from "@/server/notes/service";
import { runSemanticIndexBatch } from "./indexer";
import { searchNotes } from "./service";
import { SEMANTIC_DIMENSIONS, SEMANTIC_MODEL_ID } from "./learned";
import { sqliteSourceHash } from "./sqlite-indexer";

test("SQLite learned retrieval excludes stale passages and preserves lexical fallback on model failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-semantic-"));
  const before = { ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE,
    ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH, EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL };
  let available = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!available) return new Response("Unavailable", { status: 503 });
    const payload: { input: string[] } = await request.json();
    return Response.json({ data: payload.input.map((_, index) => ({
      index, embedding: Array.from({ length: SEMANTIC_DIMENSIONS }, (_, dimension) => Number(dimension === 0)),
    })) });
  } });
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "semantic.sqlite");
  process.env.EMBEDDING_BASE_URL = `http://127.0.0.1:${server.port}`;
  try {
    const note = await createNote({ title: "Orchard", body: "Apples and soil" });
    expect(await runSemanticIndexBatch()).toBe(1);
    const learned = await searchNotes("fruit cultivation");
    expect(learned.semanticIndex?.state).toBe("ready");
    expect(learned.hits[0]).toMatchObject({ noteId: note.id, matchedBy: ["learned"] });
    await updateNote(note.id, { body: "New local content" });
    const stale = await searchNotes("fruit cultivation");
    expect(stale.hits).toEqual([]);
    expect(stale.semanticIndex?.state).toBe("indexing");
    available = false;
    const fallback = await searchNotes("local");
    expect(fallback.hits.map(hit => hit.noteId)).toEqual([note.id]);
    expect(fallback.semanticIndex?.state).toBe("unavailable");
    available = true;
    const store = await sqliteStore();
    let lastId = "";
    store.transaction(q => {
      for (let index = 1; index <= 105; index++) {
        const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
        const title = `Batch ${index}`, body = "Indexed source";
        q.run("INSERT INTO notes(id,title,body) VALUES (?,?,?)", [id, title, body]);
        q.run("INSERT INTO note_passages(note_id,model_id,source_hash,ordinal,heading,start_line,end_line,content,embedding) VALUES (?,?,?,0,'',1,1,?,?)",
          [id, SEMANTIC_MODEL_ID, sqliteSourceHash(title, body), body,
            JSON.stringify(Array.from({ length: SEMANTIC_DIMENSIONS }, (_, dimension) => Number(dimension === (index === 105 ? 0 : 1))))]);
        lastId = id;
      }
    });
    expect((await searchNotes("cultivation concept", { limit: 1 })).hits.map(hit => hit.noteId)).toEqual([lastId]);
  } finally {
    await server.stop(true);
    await closeSQLiteStore();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
