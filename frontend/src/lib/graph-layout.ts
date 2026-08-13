import type { EntitiesExtract } from "@/api/models";
import type { ConnectivityGraph, GraphEdge, GraphNode, StoreyBand } from "@/types/graph";

const CATEGORY_COLORS: Record<string, string> = {
  core: "#ef4444",
  office: "#3b82f6",
  amenity: "#22c55e",
  service: "#eab308",
  public: "#94a3b8",
  circulation: "#64748b",
  default: "#60a5fa",
};

export function categoryColor(category?: string, kind?: string): string {
  if (kind === "stair" || kind === "lift") return CATEGORY_COLORS["core"]!;
  if (kind === "door") return "#94a3b8";
  return CATEGORY_COLORS[category ?? ""] ?? CATEGORY_COLORS["default"]!;
}

export function deriveStoreyBands(
  graph: ConnectivityGraph,
  entities?: EntitiesExtract | null,
): StoreyBand[] {
  const used = new Set<string>();
  let hasUnassigned = false;
  for (const node of graph.nodes) {
    if (node.kind !== "space") continue;
    if (node.storey_global_id) used.add(node.storey_global_id);
    else hasUnassigned = true;
  }

  let bands: StoreyBand[] = [];

  if (entities?.storeys?.length) {
    bands = [...entities.storeys]
      .filter((s) => used.has(s.global_id))
      .map((s) => ({
        id: s.global_id,
        label: s.name || s.global_id.slice(0, 8),
        elevation: s.elevation ?? 0,
      }))
      .sort((a, b) => b.elevation - a.elevation);
  }

  if (!bands.length && used.size) {
    bands = [...used]
      .sort()
      .map((id, index) => ({
        id,
        label: `Storey ${id.slice(0, 8)}`,
        elevation: used.size - index,
      }));
  }

  if (hasUnassigned || !bands.length) {
    bands.push({
      id: "__none__",
      label: bands.length ? "Unassigned" : "All spaces",
      elevation: -Infinity,
    });
  }

  return bands;
}

export type DisplayGraph = {
  nodes: GraphNode[];
  edges: Array<GraphEdge & { collapsed?: boolean }>;
};

/**
 * Hide door nodes for readability; collapse space–door–space into direct viz edges.
 * Keep stairs/lifts as portal nodes.
 */
export function toDisplayGraph(graph: ConnectivityGraph): DisplayGraph {
  const nodes = graph.nodes.filter((n) => n.kind === "space" || n.kind === "stair" || n.kind === "lift");
  const visible = new Set(nodes.map((n) => n.id));
  const edges: DisplayGraph["edges"] = [];
  const seen = new Set<string>();

  const pushEdge = (edge: DisplayGraph["edges"][number]) => {
    const a = edge.source < edge.target ? edge.source : edge.target;
    const b = edge.source < edge.target ? edge.target : edge.source;
    const key = `${edge.kind}:${a}|${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const edge of graph.edges) {
    if (visible.has(edge.source) && visible.has(edge.target)) {
      pushEdge({ ...edge });
    }
  }

  const spacesByDoor = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const doorId = edge.source.startsWith("door:")
      ? edge.source
      : edge.target.startsWith("door:")
        ? edge.target
        : null;
    const spaceId = edge.source.startsWith("space:")
      ? edge.source
      : edge.target.startsWith("space:")
        ? edge.target
        : null;
    if (!doorId || !spaceId || !visible.has(spaceId)) continue;
    const list = spacesByDoor.get(doorId) ?? [];
    if (!list.includes(spaceId)) list.push(spaceId);
    spacesByDoor.set(doorId, list);
  }

  for (const [doorId, spaces] of spacesByDoor) {
    for (let i = 0; i < spaces.length; i++) {
      for (let j = i + 1; j < spaces.length; j++) {
        const a = spaces[i];
        const b = spaces[j];
        if (!a || !b) continue;
        pushEdge({
          id: `viz-door:${doorId}:${a}:${b}`,
          kind: "space_door",
          source: a,
          target: b,
          method: "ifc_rel_space_boundary",
          bidirectional: true,
          collapsed: true,
        });
      }
    }
  }

  return { nodes, edges };
}

export type LayoutNode = {
  id: string;
  kind: "label" | "space" | "stair" | "lift";
  label: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
  vertical: boolean;
};

export type GraphLayout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
};

/** Level-banded free layout used by the Cytoscape canvas (Option A). */
export function buildGraphLayout(graph: ConnectivityGraph, bands: StoreyBand[]): GraphLayout {
  const display = toDisplayGraph(graph);
  const bandGap = 64;
  const bandIndex = new Map(bands.map((b, i) => [b.id, i]));
  const nodes: LayoutNode[] = [];

  const spacesByStorey = new Map<string, GraphNode[]>();
  for (const node of display.nodes) {
    if (node.kind !== "space") continue;
    const key = node.storey_global_id ?? "__none__";
    const list = spacesByStorey.get(key) ?? [];
    list.push(node);
    spacesByStorey.set(key, list);
  }
  for (const list of spacesByStorey.values()) {
    list.sort((a, b) => (a.name || a.global_id).localeCompare(b.name || b.global_id));
  }

  const maxOnStorey = Math.max(1, ...[...spacesByStorey.values()].map((l) => l.length));
  const cols = Math.min(10, Math.max(4, Math.ceil(Math.sqrt(maxOnStorey * 1.4))));
  const cellW = 150;
  const cellH = 120;
  const topPad = 56;
  const bottomPad = 40;

  const bandHeights = bands.map((band) => {
    const count = (spacesByStorey.get(band.id) ?? []).length;
    const rows = Math.max(1, Math.ceil(count / cols));
    return topPad + rows * cellH + bottomPad;
  });

  let yCursor = 0;
  const bandOriginY: number[] = [];
  bands.forEach((_, i) => {
    bandOriginY.push(yCursor);
    yCursor += (bandHeights[i] ?? 200) + bandGap;
  });

  bands.forEach((band, i) => {
    nodes.push({
      id: `label:${band.id}`,
      kind: "label",
      label: band.label,
      color: "transparent",
      x: 12,
      y: (bandOriginY[i] ?? 0) + (bandHeights[i] ?? 200) / 2,
      w: 120,
      h: 24,
    });
  });

  // Shorter stair/lift labels so they don't dominate the view.
  for (const node of display.nodes) {
    if (node.kind === "space") {
      const storey = node.storey_global_id ?? "__none__";
      const idx = bandIndex.has(storey)
        ? (bandIndex.get(storey) as number)
        : (bandIndex.get("__none__") ?? Math.max(bands.length - 1, 0));
      const siblings = spacesByStorey.get(storey) ?? [];
      const order = Math.max(siblings.findIndex((n) => n.id === node.id), 0);
      const col = order % cols;
      const row = Math.floor(order / cols);
      const label = node.name || node.global_id.slice(0, 8);
      nodes.push({
        id: node.id,
        kind: "space",
        label: label.length > 22 ? `${label.slice(0, 20)}…` : label,
        color: categoryColor(node.category, node.kind),
        x: 160 + col * cellW,
        y: (bandOriginY[idx] ?? 0) + topPad + row * cellH,
        w: 96,
        h: 64,
      });
    } else if (node.kind === "stair" || node.kind === "lift") {
      const totalH = Math.max(yCursor - bandGap, 200);
      const raw = node.name || node.kind;
      nodes.push({
        id: node.id,
        kind: node.kind,
        label: raw.length > 18 ? `${node.kind}` : raw,
        color: categoryColor(node.category, node.kind),
        x: 70,
        y: totalH / 2 + (node.kind === "lift" ? 48 : -48),
        w: 80,
        h: 44,
      });
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: LayoutEdge[] = [];
  const seen = new Set<string>();
  for (const edge of display.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const key = `${edge.source}|${edge.target}`;
    const rev = `${edge.target}|${edge.source}`;
    if (seen.has(key) || seen.has(rev)) continue;
    seen.add(key);
    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      vertical: edge.kind === "vertical",
    });
  }

  let maxX = 400;
  let maxY = 300;
  for (const n of nodes) {
    maxX = Math.max(maxX, n.x + n.w + 40);
    maxY = Math.max(maxY, n.y + n.h + 40);
  }

  return { nodes, edges, width: maxX, height: maxY };
}

export type GraphThemePalette = {
  bg: string;
  label: string;
  nodeLabel: string;
  nodeBorder: string;
  edge: string;
  vertical: string;
  path: string;
};

export function graphPalette(theme: "light" | "dark"): GraphThemePalette {
  if (theme === "dark") {
    return {
      bg: "#0f1419",
      label: "#94a3b8",
      nodeLabel: "#f1f5f9",
      nodeBorder: "#334155",
      edge: "#64748b",
      vertical: "#fb923c",
      path: "#3b82f6",
    };
  }
  return {
    bg: "#f8fafc",
    label: "#64748b",
    nodeLabel: "#0f172a",
    nodeBorder: "#cbd5e1",
    edge: "#94a3b8",
    vertical: "#ea580c",
    path: "#2563eb",
  };
}

/** @deprecated use graphPalette */
export const cyPalette = graphPalette;
