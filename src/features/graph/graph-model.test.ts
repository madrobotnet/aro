import { describe, expect, test } from "bun:test";
import { copyParityIssues } from "@/lib/i18n/copy";
import { LOCALES } from "@/lib/i18n/locale";
import type { GraphData } from "@/lib/types";
import { GRAPH_COPY } from "./graph-copy";
import { cloneGraphData, graphKey, graphTooltip, neighborIds, showGraphLabel, stablePaletteIndex, visibleLegendTags } from "./graph-model";

const data: GraphData = {
  nodes: [
    { id: "a", kind: "note", label: "A", tags: ["work", "idea"], degree: 1, updatedAt: null },
    { id: "b", kind: "note", label: "B", tags: ["idea"], degree: 1, updatedAt: null },
  ],
  links: [{ source: "a", target: "b", kind: "link" }],
  focusId: null,
  truncated: false,
};

describe("graph model", () => {
  test("shows small graph titles but gates dense graph labels by zoom and active neighborhood", () => {
    const neighbors = new Set(["a", "b"]);
    const visibility = [
      showGraphLabel("a", 5, 0.5, null, neighbors),
      showGraphLabel("a", 100, 1, null, neighbors),
      showGraphLabel("a", 100, 2, null, neighbors),
      showGraphLabel("a", 100, 0.5, "a", neighbors),
      showGraphLabel("b", 100, 1, "a", neighbors),
      showGraphLabel("b", 100, 1.2, "a", neighbors),
      showGraphLabel("c", 100, 2, "a", neighbors),
    ];
    expect(visibility).toEqual([true, false, true, true, false, true, false]);
  });

  test("encodes every server-side graph filter", () => {
    expect(graphKey({ focusId: "note-id", depth: 3, includeTags: true, includeOrphans: false, tag: "work" })).toBe(
      "/api/graph?depth=3&tags=1&orphans=0&focus=note-id&tag=work",
    );
  });

  test("clones nested DTO values before force-graph mutates them", () => {
    const cloned = cloneGraphData(data);
    expect(cloned).toEqual({ nodes: data.nodes, links: data.links });
    expect(cloned.nodes[0]).not.toBe(data.nodes[0]);
    expect(cloned.nodes[0]!.tags).not.toBe(data.nodes[0]!.tags);
    expect(cloned.links[0]).not.toBe(data.links[0]);
  });

  test("finds neighbors before and after link endpoint mutation", () => {
    const cloned = cloneGraphData(data);
    expect([...neighborIds(cloned, "a")].sort()).toEqual(["a", "b"]);
    cloned.links[0]!.source = cloned.nodes[0]!;
    cloned.links[0]!.target = cloned.nodes[1]!;
    expect([...neighborIds(cloned, "b")].sort()).toEqual(["a", "b"]);
  });

  test("uses deterministic tag groups and a sorted unique legend", () => {
    expect(stablePaletteIndex("a", 4)).toBe(0);
    expect(stablePaletteIndex("b", 4)).toBe(1);
    expect(visibleLegendTags(data.nodes)).toEqual(["idea", "work"]);
  });

  test("keeps title markup inert at the HTML tooltip boundary", () => {
    for (const locale of LOCALES) {
      const tooltip = graphTooltip({ label: '<b data-qa-tooltip>A & B</b>', degree: 0 }, locale);
      expect(tooltip).toStartWith('&lt;b data-qa-tooltip&gt;A &amp; B&lt;/b&gt;');
      expect(tooltip).not.toContain("<");
    }
  });

  test("keeps Korean and English graph copy in parity", () => {
    expect(copyParityIssues(GRAPH_COPY)).toEqual([]);
  });

  test("renders the tooltip connection count from the requested locale", () => {
    for (const locale of LOCALES) {
      for (const degree of [0, 1, 2]) {
        expect(graphTooltip({ label: "A", degree }, locale)).toEndWith(GRAPH_COPY[locale].canvas.tooltipLinks(degree));
      }
    }
  });
});
