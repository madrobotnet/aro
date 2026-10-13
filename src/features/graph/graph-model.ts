import type { Locale } from "@/lib/i18n/locale";
import type { GraphData, GraphLink, GraphNode } from "@/lib/types";
import { GRAPH_COPY } from "./graph-copy";

export type GraphFilters = {
  focusId: string | null;
  depth: 1 | 2 | 3;
  includeTags: boolean;
  includeOrphans: boolean;
  tag: string;
};

export type MutableGraphNode = GraphNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
};

export type MutableGraphLink = Omit<GraphLink, "source" | "target"> & {
  source: string | MutableGraphNode;
  target: string | MutableGraphNode;
};

export type MutableGraphData = { nodes: MutableGraphNode[]; links: MutableGraphLink[] };

export function graphKey(filters: GraphFilters): string {
  const query = new URLSearchParams({
    depth: String(filters.depth),
    tags: filters.includeTags ? "1" : "0",
    orphans: filters.includeOrphans ? "1" : "0",
  });
  if (filters.focusId) query.set("focus", filters.focusId);
  if (filters.tag) query.set("tag", filters.tag);
  return `/api/graph?${query.toString()}`;
}

/** force-graph mutates nodes and link endpoints, so wire DTOs never cross this boundary directly. */
export function cloneGraphData(data: GraphData): MutableGraphData {
  return {
    nodes: data.nodes.map((node) => ({ ...node, tags: [...node.tags] })),
    links: data.links.map((link) => ({ ...link })),
  };
}

export function endpointId(endpoint: string | MutableGraphNode): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

/** The canvas library interprets labels as HTML, unlike React text children. */
export function graphTooltip(node: Pick<GraphNode, "label" | "degree">, locale: Locale): string {
  const label = node.label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `${label} · ${GRAPH_COPY[locale].canvas.tooltipLinks(node.degree)}`;
}

export function neighborIds(data: MutableGraphData, nodeId: string | null): Set<string> {
  const neighbors = new Set<string>();
  if (!nodeId) return neighbors;
  neighbors.add(nodeId);
  for (const link of data.links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (source === nodeId) neighbors.add(target);
    if (target === nodeId) neighbors.add(source);
  }
  return neighbors;
}

/** Dense overviews stay quiet; zoom or an active neighborhood reveals their titles. */
export function showGraphLabel(nodeId: string, count: number, scale: number, activeId: string | null, neighbors: ReadonlySet<string>): boolean {
  if (count <= 20) return true;
  if (activeId) return nodeId === activeId || (scale >= 1.2 && neighbors.has(nodeId));
  return scale >= 2;
}

export function primaryTag(node: GraphNode): string | null {
  return node.kind === "tag" ? node.label : node.tags[0] ?? null;
}

export function stablePaletteIndex(value: string, paletteSize: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return paletteSize > 0 ? (hash >>> 0) % paletteSize : 0;
}

export function visibleLegendTags(nodes: readonly GraphNode[]): string[] {
  return [...new Set(nodes.flatMap((node) => (node.kind === "note" ? node.tags : [])))].sort((a, b) => a.localeCompare(b));
}
