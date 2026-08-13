import type { EntitiesExtract } from "@/api/models";
import type { ConnectivityGraph, GraphEdge, GraphNode, StoreyBand } from "@/types/graph";

/** Minimum center-to-center gap in layout units (prevents overlap after framing). */
export const LAYOUT_NODE_W = 72;
export const LAYOUT_NODE_H = 72;
export const LAYOUT_PORTAL_W = 88;
export const LAYOUT_PORTAL_H = 48;
/** Extra gap between node bounding boxes (in addition to node size). */
export const LAYOUT_NODE_GAP_X = 56;
export const LAYOUT_NODE_GAP_Y = 48;
/** Vertical gap between storey bands (empty air between clusters). */
export const LAYOUT_BAND_GAP = 64;
export const LAYOUT_GUTTER_X = 168;
export const LAYOUT_TOP_PAD = 48;
export const LAYOUT_BOTTOM_PAD = 36;

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
  /** Center-to-center cell size used by framing to enforce min screen margins. */
  cellW: number;
  cellH: number;
};

/** Level-banded free layout — explicit per-cell margins so nodes never collide. */
export function buildGraphLayout(graph: ConnectivityGraph, bands: StoreyBand[]): GraphLayout {
  const display = toDisplayGraph(graph);
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
  // Prefer wider rows over cramped multi-row stacks when possible.
  const cols = Math.min(8, Math.max(3, Math.ceil(Math.sqrt(maxOnStorey))));
  const cellW = LAYOUT_NODE_W + LAYOUT_NODE_GAP_X;
  const cellH = LAYOUT_NODE_H + LAYOUT_NODE_GAP_Y;

  const bandHeights = bands.map((band) => {
    const count = (spacesByStorey.get(band.id) ?? []).length;
    const rows = Math.max(1, Math.ceil(count / cols));
    // Sparse floors keep a shorter band so empty storeys don't inflate gaps.
    const top = count <= 2 ? 36 : LAYOUT_TOP_PAD;
    const bottom = count <= 2 ? 28 : LAYOUT_BOTTOM_PAD;
    return top + rows * cellH + bottom;
  });

  let yCursor = 0;
  const bandOriginY: number[] = [];
  bands.forEach((_, i) => {
    bandOriginY.push(yCursor);
    yCursor += (bandHeights[i] ?? 240) + LAYOUT_BAND_GAP;
  });

  bands.forEach((band, i) => {
    nodes.push({
      id: `label:${band.id}`,
      kind: "label",
      label: band.label,
      x: 16,
      y: (bandOriginY[i] ?? 0) + (bandHeights[i] ?? 240) / 2 - 12,
      w: 140,
      h: 24,
    });
  });

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
        label: label.length > 20 ? `${label.slice(0, 18)}…` : label,
        x: LAYOUT_GUTTER_X + col * cellW,
        y: (bandOriginY[idx] ?? 0) + LAYOUT_TOP_PAD + row * cellH,
        w: LAYOUT_NODE_W,
        h: LAYOUT_NODE_H,
      });
    } else if (node.kind === "stair" || node.kind === "lift") {
      const totalH = Math.max(yCursor - LAYOUT_BAND_GAP, 240);
      const raw = node.name || node.kind;
      nodes.push({
        id: node.id,
        kind: node.kind,
        label: raw.length > 16 ? node.kind : raw,
        x: 48,
        y: totalH / 2 + (node.kind === "lift" ? 56 : -56) - LAYOUT_PORTAL_H / 2,
        w: LAYOUT_PORTAL_W,
        h: LAYOUT_PORTAL_H,
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

  let maxX = 480;
  let maxY = 360;
  for (const n of nodes) {
    maxX = Math.max(maxX, n.x + n.w + 48);
    maxY = Math.max(maxY, n.y + n.h + 48);
  }

  return { nodes, edges, width: maxX, height: maxY, cellW, cellH };
}

/** Cosmograph-inspired palette for Cytoscape (light / dark). */
export type GraphThemePalette = {
  bg: string;
  label: string;
  spaceFill: string;
  spaceLabel: string;
  spaceBorder: string;
  portalFill: string;
  portalLabel: string;
  portalBorder: string;
  edge: string;
  edgeOpacity: number;
  vertical: string;
  verticalOpacity: number;
  path: string;
  pathNode: string;
  pathUnderlay: string;
};

export function graphPalette(theme: "light" | "dark"): GraphThemePalette {
  if (theme === "dark") {
    return {
      bg: "#0F1117",
      label: "#94A3B8",
      spaceFill: "#2D3748",
      spaceLabel: "#E2E8F0",
      spaceBorder: "#475569",
      portalFill: "#7C2D12",
      portalLabel: "#FFEDD5",
      portalBorder: "#9A3412",
      edge: "#1E293B",
      edgeOpacity: 0.5,
      vertical: "#B45309",
      verticalOpacity: 0.25,
      path: "#FFB703",
      pathNode: "#00E5FF",
      pathUnderlay: "#00E5FF",
    };
  }
  return {
    bg: "#F8FAFC",
    label: "#64748B",
    spaceFill: "#E2E8F0",
    spaceLabel: "#1E293B",
    spaceBorder: "#CBD5E1",
    portalFill: "#FFEDD5",
    portalLabel: "#9A3412",
    portalBorder: "#FDBA74",
    edge: "#CBD5E1",
    edgeOpacity: 0.6,
    vertical: "#F97316",
    verticalOpacity: 0.25,
    path: "#1D4ED8",
    pathNode: "#2563EB",
    pathUnderlay: "#2563EB",
  };
}

/** @deprecated use graphPalette */
export const cyPalette = graphPalette;
