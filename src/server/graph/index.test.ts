import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { query } from "@/server/db";
import { closeDb, connectTestDatabase, resetData } from "@/server/test/db";
import { ApiError } from "@/server/http";
import { getGraph, GRAPH_NODE_LIMIT, parseGraphQuery } from "./index";

connectTestDatabase();

const IDS = {
  a: "00000000-0000-4000-8000-000000000001",
  b: "00000000-0000-4000-8000-000000000002",
  c: "00000000-0000-4000-8000-000000000003",
  d: "00000000-0000-4000-8000-000000000004",
  e: "00000000-0000-4000-8000-000000000005",
} as const;

async function addNote(
  id: string,
  title: string,
  options: { tags?: string[]; status?: string; deleted?: boolean } = {},
): Promise<void> {
  await query(
    `INSERT INTO notes (id, title, body, tags, status, deleted_at, created_at, updated_at)
     VALUES ($1, $2, '', $3, $4, $5, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [id, title, options.tags ?? [], options.status ?? "draft", options.deleted ? new Date("2026-01-02T00:00:00Z") : null],
  );
}

async function addLink(source: string, target: string): Promise<void> {
  await query("INSERT INTO links (from_note_id, to_note_id) VALUES ($1, $2)", [source, target]);
}

beforeEach(resetData);
afterAll(closeDb);

describe("getGraph", () => {
  test("includes daily metadata in global and focused projections without rewriting the title", async () => {
    await addNote(IDS.a, "2026-10-13");
    await query("UPDATE notes SET daily_date='2026-10-13' WHERE id=$1", [IDS.a]);
    for (const options of [{}, { focusId: IDS.a }]) {
      expect((await getGraph(options)).nodes.find(node => node.id === IDS.a)).toMatchObject({
        label: "2026-10-13", dailyDate: "2026-10-13",
      });
    }
  });
  test("projects active notes, tags, unresolved targets, and visible-edge degrees deterministically", async () => {
    await addNote(IDS.a, "Alpha", { tags: ["alpha", "common"] });
    await addNote(IDS.b, "Beta", { tags: ["common"] });
    await addNote(IDS.c, "Archived", { status: "archived" });
    await addNote(IDS.d, "Deleted", { deleted: true });
    await addNote(IDS.e, "Orphan", { tags: ["solo"] });
    await addLink(IDS.a, IDS.b);
    await addLink(IDS.b, IDS.c);
    await addLink(IDS.a, IDS.d);
    await query("INSERT INTO unresolved_links (from_note_id, target_title) VALUES ($1, 'Missing Note')", [IDS.a]);

    const graph = await getGraph({ includeTags: true });
    expect(graph).toMatchInlineSnapshot(`
      {
        "focusId": null,
        "links": [
          {
            "kind": "link",
            "source": "00000000-0000-4000-8000-000000000001",
            "target": "00000000-0000-4000-8000-000000000002",
          },
          {
            "kind": "unresolved",
            "source": "00000000-0000-4000-8000-000000000001",
            "target": "ghost:missing note",
          },
          {
            "kind": "tag",
            "source": "00000000-0000-4000-8000-000000000001",
            "target": "tag:alpha",
          },
          {
            "kind": "tag",
            "source": "00000000-0000-4000-8000-000000000001",
            "target": "tag:common",
          },
          {
            "kind": "tag",
            "source": "00000000-0000-4000-8000-000000000002",
            "target": "tag:common",
          },
          {
            "kind": "tag",
            "source": "00000000-0000-4000-8000-000000000005",
            "target": "tag:solo",
          },
        ],
        "nodes": [
          {
            "degree": 4,
            "id": "00000000-0000-4000-8000-000000000001",
            "kind": "note",
            "label": "Alpha",
            "tags": [
              "alpha",
              "common",
            ],
            "updatedAt": "2026-01-01T00:00:00.000Z",
          },
          {
            "degree": 2,
            "id": "00000000-0000-4000-8000-000000000002",
            "kind": "note",
            "label": "Beta",
            "tags": [
              "common",
            ],
            "updatedAt": "2026-01-01T00:00:00.000Z",
          },
          {
            "degree": 1,
            "id": "00000000-0000-4000-8000-000000000005",
            "kind": "note",
            "label": "Orphan",
            "tags": [
              "solo",
            ],
            "updatedAt": "2026-01-01T00:00:00.000Z",
          },
          {
            "degree": 1,
            "id": "tag:alpha",
            "kind": "tag",
            "label": "alpha",
            "tags": [],
            "updatedAt": null,
          },
          {
            "degree": 2,
            "id": "tag:common",
            "kind": "tag",
            "label": "common",
            "tags": [],
            "updatedAt": null,
          },
          {
            "degree": 1,
            "id": "tag:solo",
            "kind": "tag",
            "label": "solo",
            "tags": [],
            "updatedAt": null,
          },
          {
            "degree": 1,
            "id": "ghost:missing note",
            "kind": "unresolved",
            "label": "Missing Note",
            "tags": [],
            "updatedAt": null,
          },
        ],
        "truncated": false,
      }
    `);
  });

  test("traverses resolved links in both directions only to the requested local depth", async () => {
    for (const [id, title] of [[IDS.a, "Alpha"], [IDS.b, "Beta"], [IDS.c, "Charlie"], [IDS.d, "Delta"]] as const) {
      await addNote(id, title);
    }
    await addLink(IDS.b, IDS.a);
    await addLink(IDS.b, IDS.c);
    await addLink(IDS.c, IDS.d);

    const depthOne = await getGraph({ focusId: IDS.a, depth: 1 });
    const depthTwo = await getGraph({ focusId: IDS.a, depth: 2 });

    expect(depthOne.nodes.map((node) => node.id)).toEqual([IDS.a, IDS.b]);
    expect(depthTwo.nodes.map((node) => node.id)).toEqual([IDS.a, IDS.b, IDS.c]);
    expect(depthTwo.focusId).toBe(IDS.a);
  });

  test("filters notes by normalized tag", async () => {
    await addNote(IDS.a, "Alpha", { tags: ["work"] });
    await addNote(IDS.b, "Beta", { tags: ["home"] });
    await addNote(IDS.c, "Charlie", { tags: ["work"] });
    await addLink(IDS.a, IDS.c);

    const graph = await getGraph({ tag: "#WORK" });
    expect(graph.nodes.map((node) => node.id)).toEqual([IDS.a, IDS.c]);
    expect(graph.links).toHaveLength(1);
  });

  test("removes true orphans but retains notes connected to unresolved targets", async () => {
    await addNote(IDS.a, "Connected");
    await addNote(IDS.b, "Orphan");
    await query("INSERT INTO unresolved_links (from_note_id, target_title) VALUES ($1, 'Future')", [IDS.a]);

    const graph = await getGraph({ includeOrphans: false });
    expect(graph.nodes.map((node) => node.id)).toEqual([IDS.a, "ghost:future"]);
  });

  test("caps the global projection and reports truncation", async () => {
    await query(
      `INSERT INTO notes (title, body)
       SELECT 'Note ' || lpad(i::text, 4, '0'), '' FROM generate_series(1, $1) AS i`,
      [GRAPH_NODE_LIMIT + 1],
    );

    const graph = await getGraph();
    expect(graph.nodes).toHaveLength(GRAPH_NODE_LIMIT);
    expect(graph.truncated).toBe(true);
  });

  test("rejects a deleted focus instead of traversing its dangling links", async () => {
    await addNote(IDS.a, "Active");
    await addNote(IDS.d, "Deleted", { deleted: true });
    await addLink(IDS.a, IDS.d);

    await expect(getGraph({ focusId: IDS.d })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("parseGraphQuery", () => {
  test("rejects malformed focus UUIDs", () => {
    expect(() => parseGraphQuery(new URL("http://localhost/api/graph?focus=nope"))).toThrow(ApiError);
    try {
      parseGraphQuery(new URL("http://localhost/api/graph?focus=nope"));
    } catch (error) {
      expect(error).toMatchObject({ code: "validation" });
    }
  });

  test("rejects out-of-range depths and non-binary flags", () => {
    for (const queryString of ["depth=0", "depth=4", "depth=2.5", "tags=yes", "orphans=-1"]) {
      expect(() => parseGraphQuery(new URL(`http://localhost/api/graph?${queryString}`))).toThrow(ApiError);
    }
  });
});
