import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSQLiteStore } from "@/server/db/backend";
import { createNote, getOrCreateDaily, updateNote } from "@/server/notes/service";
import { getGraph } from "./index";

test("SQLite graphs retain edges, ghosts, tags and bounded focus depth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aro-graph-"));
  const before = { ARO_DATABASE_MODE: process.env.ARO_DATABASE_MODE, ARO_SQLITE_PATH: process.env.ARO_SQLITE_PATH };
  process.env.ARO_DATABASE_MODE = "sqlite";
  process.env.ARO_SQLITE_PATH = join(directory, "graph.sqlite");
  try {
    const a = await createNote({ title: "A", body: "[[B]] [[Missing]]", tags: ["work"] });
    const b = await createNote({ title: "B", body: "[[C]]", tags: ["work"] });
    const c = await createNote({ title: "C", body: "", tags: ["work"] });
    const orphan = await createNote({ title: "Orphan" });
    const daily = await getOrCreateDaily("2026-10-13");
    for (const options of [{}, { focusId: daily.id }]) {
      expect((await getGraph(options)).nodes.find(node => node.id === daily.id)).toMatchObject({
        label: "2026-10-13", dailyDate: "2026-10-13",
      });
    }
    const graph = await getGraph({ focusId: a.id.toUpperCase(), depth: 1, includeTags: true });
    expect(graph.nodes.map(node => node.id)).toContain(b.id);
    expect(graph.nodes.map(node => node.id)).not.toContain(c.id);
    expect(graph.nodes.map(node => node.id)).toContain("ghost:missing");
    expect(graph.nodes.map(node => node.id)).toContain("tag:work");
    expect(graph.links).toContainEqual({ source: a.id, target: b.id, kind: "link" });
    expect((await getGraph({ focusId: a.id, depth: 2 })).nodes.map(node => node.id)).toContain(c.id);
    expect((await getGraph({ includeOrphans: false })).nodes.map(node => node.id)).not.toContain(orphan.id);
    await updateNote(b.id, { archived: true });
    expect((await getGraph()).nodes.map(node => node.id)).not.toContain(b.id);
  } finally {
    await closeSQLiteStore();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
