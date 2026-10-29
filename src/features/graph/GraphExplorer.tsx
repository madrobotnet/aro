"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Focus, Maximize2, Minus, Network, Pin, PinOff, Plus, RefreshCw, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClassName } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import type { GraphData, GraphNode, NoteRef, TagCount } from "@/lib/types";
import { GRAPH_COPY } from "./graph-copy";
import { displayGraphData, graphKey, stablePaletteIndex, visibleLegendTags } from "./graph-model";
import type { GraphCanvasHandle } from "./ForceGraphCanvas";

const ForceGraphCanvas = dynamic(() => import("./ForceGraphCanvas").then((module) => module.ForceGraphCanvas), {
  ssr: false,
  loading: () => <Skeleton className="h-full min-h-80 w-full rounded-card" />,
});

type Props = { noteId?: string; depth?: 1 | 2 | 3; height?: number; compact?: boolean };
const PALETTE_CLASSES = ["bg-graph-1", "bg-graph-2", "bg-graph-3", "bg-graph-4", "bg-graph-5", "bg-graph-6"] as const;
// Segmented scope toggle: the pressed state is a raised card on a tonal track, never an accent fill.
const SCOPE_BUTTON = "aria-pressed:bg-card aria-pressed:font-medium aria-pressed:text-ink aria-pressed:shadow-card aria-pressed:ring-1 aria-pressed:ring-line-strong not-aria-pressed:text-mute not-aria-pressed:hover:text-ink";

export function GraphExplorer({ noteId, depth: initialDepth = 1, height = 560, compact = false }: Props) {
  const router = useRouter();
  const { locale } = useLocale();
  const copy = useCopy(GRAPH_COPY);
  const canvasRef = useRef<GraphCanvasHandle>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<string | null>(noteId ?? null);
  const [depth, setDepth] = useState<1 | 2 | 3>(initialDepth);
  const [includeTags, setIncludeTags] = useState(false);
  const [includeOrphans, setIncludeOrphans] = useState(true);
  const [tag, setTag] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pins, setPins] = useState<{ graph: GraphData | undefined; ids: Set<string> }>({ graph: undefined, ids: new Set() });
  const [creating, setCreating] = useState(false);
  // Keep the failure itself, not a translated message, so it re-renders after a language switch.
  const [actionError, setActionError] = useState<{ cause: unknown } | null>(null);
  const filters = { focusId, depth, includeTags, includeOrphans, tag };
  const key = graphKey(filters);
  const { data: wireData, error, isLoading, mutate } = useSWR<GraphData>(key, { keepPreviousData: true, shouldRetryOnError: false });
  const data = useMemo(() => wireData ? displayGraphData(wireData, locale) : undefined, [wireData, locale]);
  const { data: tagData } = useSWR<{ tags: TagCount[] }>(compact ? null : "/api/tags", { shouldRetryOnError: false });
  const selected = data?.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedNodeId = selected?.id;
  useEffect(() => {
    if (selectedNodeId) inspectorRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedNodeId]);
  const selectedNeighbors = useMemo(() => {
    if (!data || !selectedId) return [];
    const ids = new Set<string>();
    for (const link of data.links) {
      if (link.source === selectedId) ids.add(link.target);
      if (link.target === selectedId) ids.add(link.source);
    }
    return data.nodes.filter((node) => ids.has(node.id));
  }, [data, selectedId]);
  const legend = useMemo(() => visibleLegendTags(data?.nodes ?? []), [data]);

  const recordPin = (nodeId: string, isPinned: boolean) => setPins((current) => {
    const ids = new Set(current.graph === data ? current.ids : []);
    if (isPinned) ids.add(nodeId); else ids.delete(nodeId);
    return { graph: data, ids };
  });
  const enterLocal = (id: string) => {
    setFocusId(id);
    setSelectedId(id);
  };
  const reset = () => {
    setSelectedId(null);
    setTag("");
    setIncludeTags(false);
    setIncludeOrphans(true);
    setDepth(initialDepth);
    setPins({ graph: data, ids: new Set() });
    if (!noteId) setFocusId(null);
    canvasRef.current?.reset();
  };
  const createUnresolved = async (node: GraphNode) => {
    setCreating(true);
    setActionError(null);
    try {
      const { note } = await api<{ note: NoteRef }>("/api/notes/by-title", { method: "POST", json: { title: node.label } });
      router.push(`/notes/${note.id}`);
    } catch (cause) {
      setActionError({ cause });
    } finally {
      setCreating(false);
    }
  };
  const togglePin = () => {
    if (!selected) return;
    const isPinned = canvasRef.current?.togglePin(selected.id) ?? false;
    recordPin(selected.id, isPinned);
  };

  return (
    <section className="space-y-3" aria-label={compact ? copy.region.local : copy.region.explorer}>
      <div className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-desk p-2">
        {!noteId ? (
          <div role="group" className="flex rounded-ctl bg-canvas p-1 ring-1 ring-inset ring-line" aria-label={copy.toolbar.scope}>
            <Button size="sm" variant="ghost" className={SCOPE_BUTTON} aria-pressed={!focusId} onClick={() => { setFocusId(null); setSelectedId(null); }}>{copy.toolbar.all}</Button>
            <Button size="sm" variant="ghost" className={SCOPE_BUTTON} aria-pressed={Boolean(focusId)} disabled={!focusId && selected?.kind !== "note"} onClick={() => selected?.kind === "note" && enterLocal(selected.id)}>{copy.toolbar.local}</Button>
          </div>
        ) : null}
        <label className="flex items-center gap-2 text-sm text-mute">
          {copy.toolbar.depth}
          <select aria-label={copy.toolbar.depthLabel} className="h-touch lg:h-8 rounded-ctl border border-control-boundary bg-card px-2 text-ink focus-ring" value={depth} onChange={(event) => setDepth(Number(event.target.value) as 1 | 2 | 3)}>
            <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
          </select>
        </label>
        {!compact ? (
          <label className="flex items-center gap-2 text-sm text-mute">
            {copy.toolbar.tagFilter}
            <select className="h-touch lg:h-8 max-w-40 rounded-ctl border border-control-boundary bg-card px-2 text-ink focus-ring" value={tag} onChange={(event) => setTag(event.target.value)}>
              <option value="">{copy.toolbar.allTags}</option>
              {tagData?.tags.map((item) => <option key={item.tag} value={item.tag}>{item.tag} ({item.count})</option>)}
            </select>
          </label>
        ) : null}
        <label className="flex min-h-touch items-center gap-2 lg:min-h-8 text-sm text-ink"><input className="size-4 accent-accent" type="checkbox" checked={includeTags} onChange={(event) => setIncludeTags(event.target.checked)} />{copy.toolbar.tagNodes}</label>
        <label className="flex min-h-touch items-center gap-2 lg:min-h-8 text-sm text-ink"><input className="size-4 accent-accent" type="checkbox" checked={includeOrphans} onChange={(event) => setIncludeOrphans(event.target.checked)} />{copy.toolbar.orphans}</label>
        <span className="ml-auto text-sm text-mute" aria-live="polite">{data ? copy.toolbar.stats(data.nodes.length, data.links.length) : ""}</span>
      </div>

      {error && data ? <p role="alert" className="rounded-card border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{copy.status.stale}</p> : null}
      {error && !data ? (
        <div role="alert" className="rounded-card border border-danger/30 bg-danger-soft p-4">
          <p className="font-medium text-danger">{copy.status.loadFailed}</p>
          <p className="mt-1 text-sm text-ink">{localizedApiError(error, locale, copy.status.loadFallback)}</p>
          <Button className="mt-3" size="sm" leading={<RefreshCw aria-hidden className="size-4" />} onClick={() => void mutate()}>{copy.status.retry}</Button>
        </div>
      ) : isLoading && !data ? (
        <Skeleton className="w-full rounded-card" style={{ height }} />
      ) : data && data.nodes.length === 0 ? (
        <EmptyState icon={Network} title={copy.empty.title} description={tag ? copy.empty.filtered : copy.empty.unfiltered} action={tag ? <Button size="sm" onClick={() => setTag("")}>{copy.empty.clearFilter}</Button> : undefined} />
      ) : data ? (
        <>
          <div className="relative overflow-hidden rounded-card border border-line bg-card shadow-card">
            <ForceGraphCanvas
              ref={canvasRef}
              data={data}
              height={height}
              selectedId={selectedId}
              onSelect={(node) => setSelectedId(node?.id ?? null)}
              onPinChange={recordPin}
            />
            <div className="absolute left-2 top-2 flex gap-1 rounded-ctl border border-line bg-card/90 p-1 shadow-card">
              <Button iconOnly size="sm" className="min-h-touch min-w-touch lg:min-h-0 lg:min-w-0" variant="ghost" aria-label={copy.canvas.zoomIn} title={copy.canvas.zoomIn} onClick={() => canvasRef.current?.zoomBy(1.35)}><Plus aria-hidden className="size-4" /></Button>
              <Button iconOnly size="sm" className="min-h-touch min-w-touch lg:min-h-0 lg:min-w-0" variant="ghost" aria-label={copy.canvas.zoomOut} title={copy.canvas.zoomOut} onClick={() => canvasRef.current?.zoomBy(0.75)}><Minus aria-hidden className="size-4" /></Button>
              <Button iconOnly size="sm" className="min-h-touch min-w-touch lg:min-h-0 lg:min-w-0" variant="ghost" aria-label={copy.canvas.fit} title={copy.canvas.fit} onClick={() => canvasRef.current?.fit()}><Maximize2 aria-hidden className="size-4" /></Button>
              <Button iconOnly size="sm" className="min-h-touch min-w-touch lg:min-h-0 lg:min-w-0" variant="ghost" aria-label={copy.canvas.reset} title={copy.canvas.reset} onClick={reset}><RotateCcw aria-hidden className="size-4" /></Button>
            </div>
          </div>
          {data.truncated ? <p role="status" className="text-sm text-warn">{copy.status.truncated}</p> : null}
          {legend.length ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mute" aria-label={copy.legend.label}>
              <span>{copy.legend.hint}</span>
              {legend.map((item) => <span key={item} className="inline-flex items-center gap-1"><span aria-hidden className={`size-2 rounded-pill ${PALETTE_CLASSES[stablePaletteIndex(item, PALETTE_CLASSES.length)]}`} />#{item}</span>)}
            </div>
          ) : null}
          <div ref={inspectorRef} className="scroll-mb-[calc(var(--bottomnav-h)+env(safe-area-inset-bottom,0px)+1.25rem)]">
            <Inspector node={selected} neighbors={selectedNeighbors} pinned={selected ? pins.graph === data && pins.ids.has(selected.id) : false} creating={creating} actionError={actionError ? localizedApiError(actionError.cause, locale, copy.inspector.createFailed) : null} onClose={() => { setSelectedId(null); setActionError(null); }} onSelect={setSelectedId} onPin={togglePin} onLocal={enterLocal} onCreate={createUnresolved} />
          </div>
          <AccessibleGraphList data={data} selectedId={selectedId} onSelect={(node) => setSelectedId(node.id)} />
        </>
      ) : null}
    </section>
  );
}

function Inspector({ node, neighbors, pinned, creating, actionError, onClose, onSelect, onPin, onLocal, onCreate }: { node: GraphNode | null; neighbors: GraphNode[]; pinned: boolean; creating: boolean; actionError: string | null; onClose(): void; onSelect(id: string): void; onPin(): void; onLocal(id: string): void; onCreate(node: GraphNode): void }) {
  const copy = useCopy(GRAPH_COPY).inspector;
  if (!node) return <p className="rounded-card border border-dashed border-line px-4 py-3 text-sm text-mute">{copy.empty}</p>;
  return (
    <aside id="graph-inspector" className="rounded-card border border-line bg-card p-4 shadow-card" aria-label={copy.label}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-xs font-medium text-mute">{copy.kind[node.kind]}</p><h2 className="truncate text-lg font-semibold text-ink">{node.label}</h2></div>
        <Button iconOnly size="sm" variant="ghost" aria-label={copy.close} title={copy.close} onClick={onClose}><X aria-hidden className="size-4" /></Button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">{node.tags.map((tag) => <Badge key={tag}>#{tag}</Badge>)}<Badge tone="neutral" count={node.degree}>{copy.links}</Badge></div>
      {neighbors.length ? <div className="mt-3"><p className="text-xs font-medium text-mute">{copy.neighbors}</p><div className="mt-1 flex flex-wrap gap-1">{neighbors.map((neighbor) => <button key={neighbor.id} type="button" className="min-h-touch rounded-pill border border-line bg-desk px-3 py-2 text-xs lg:min-h-8 text-ink hover:bg-line/50 focus-ring" onClick={() => onSelect(neighbor.id)}>{neighbor.label}</button>)}</div></div> : <p className="mt-3 text-sm text-mute">{copy.noNeighbors}</p>}
      {actionError ? <p role="alert" className="mt-3 text-sm text-danger">{actionError}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {node.kind === "note" ? <Link className={buttonClassName({ variant: "primary", size: "sm" })} href={`/notes/${node.id}`}>{copy.open}</Link> : null}
        {node.kind === "note" ? <Button size="sm" leading={<Focus aria-hidden className="size-4" />} onClick={() => onLocal(node.id)}>{copy.local}</Button> : null}
        <Button size="sm" leading={pinned ? <PinOff aria-hidden className="size-4" /> : <Pin aria-hidden className="size-4" />} onClick={onPin}>{pinned ? copy.unpin : copy.pin}</Button>
        {node.kind === "unresolved" ? <Button size="sm" variant="primary" loading={creating} onClick={() => void onCreate(node)}>{copy.create}</Button> : null}
      </div>
    </aside>
  );
}

function AccessibleGraphList({ data, selectedId, onSelect }: { data: GraphData; selectedId: string | null; onSelect(node: GraphNode): void }) {
  const copy = useCopy(GRAPH_COPY).list;
  return (
    <details className="rounded-card border border-line bg-desk p-3">
      <summary className="flex min-h-touch cursor-pointer items-center font-medium text-ink focus-ring">{copy.summary(data.nodes.length)}</summary>
      <ul className="mt-3 grid max-h-72 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
        {data.nodes.map((node) => <li key={node.id}><button type="button" aria-pressed={selectedId === node.id} className="flex min-h-11 w-full items-center justify-between rounded-ctl px-3 py-2 text-left text-sm text-ink hover:bg-line/50 focus-ring aria-pressed:bg-accent-soft" onClick={() => onSelect(node)}><span className="truncate">{node.label}</span><span className="ml-2 shrink-0 text-xs text-mute">{node.degree}</span></button></li>)}
      </ul>
    </details>
  );
}
