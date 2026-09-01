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

/** Map edge method/kind → viewer heal colour channel. */
export function healKindForEdge(
  method: GraphEdge["method"],
  kind: GraphEdge["kind"],
  inferred: boolean,
): "door" | "space" | "stair" | undefined {
  if (!inferred) return undefined;
  if (method === "geom_door_space" || kind === "space_door") return "door";
  if (method === "geom_stair_space" || kind === "vertical") return "stair";
  if (
    method === "geom_opening_space" ||
    method === "topologicpy_adjacency" ||
    kind === "space_space"
  ) {
    return "space";
  }
  // Fallback: other inferred methods (legacy) → space channel.
  return "space";
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
  /** doorId → spaceId → link is inferred (geometry heal / non-IFC). */
  const doorSpaceInferred = new Map<string, Map<string, boolean>>();
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

    const inferred =
      Boolean(edge.inferred) ||
      edge.method === "geom_door_space" ||
      edge.method !== "ifc_rel_space_boundary";
    const bySpace = doorSpaceInferred.get(doorId) ?? new Map<string, boolean>();
    bySpace.set(spaceId, Boolean(bySpace.get(spaceId)) || inferred);
    doorSpaceInferred.set(doorId, bySpace);
  }

  for (const [doorId, spaces] of spacesByDoor) {
    const flags = doorSpaceInferred.get(doorId);
    for (let i = 0; i < spaces.length; i++) {
      for (let j = i + 1; j < spaces.length; j++) {
        const a = spaces[i];
        const b = spaces[j];
        if (!a || !b) continue;
        // Yellow if either door↔space side was geometry-healed (partial IFC top-up too).
        const inferred = Boolean(flags?.get(a) || flags?.get(b));
        pushEdge({
          id: `viz-door:${doorId}:${a}:${b}`,
          kind: "space_door",
          source: a,
          target: b,
          method: inferred ? "geom_door_space" : "ifc_rel_space_boundary",
          bidirectional: true,
          inferred,
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
  /** Geometry rules: candidate nested parent (red circle in viewer). */
  nestedParent?: boolean;
  /** Temporarily removed from the live network (parked in the right-hand grid). */
  excluded?: boolean;
};

export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
  vertical: boolean;
  inferred?: boolean;
  /** Heal colour channel: door=yellow, space=green, stair=purple. */
  heal?: "door" | "space" | "stair";
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

/** Stable 0..1 from id — keeps force seeds deterministic across reloads. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Connected components over undirected edges (nodes with no edges are singleton comps). */
function connectedComponents(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>,
): string[][] {
  const idSet = new Set(nodeIds);
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target) || e.source === e.target) continue;
    adj.get(e.source)!.push(e.target);
    adj.get(e.target)!.push(e.source);
  }

  const seen = new Set<string>();
  const comps: string[][] = [];
  for (const id of nodeIds) {
    if (seen.has(id)) continue;
    const stack = [id];
    const comp: string[] = [];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        stack.push(nb);
      }
    }
    comp.sort((a, b) => a.localeCompare(b));
    comps.push(comp);
  }
  // Largest components first, then isolates — keeps the main cluster on the left.
  comps.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  return comps;
}

/** Minimum clear air between node bounding-box edges (layout units ≈ px at 1:1). */
export const LAYOUT_MIN_EDGE_GAP = 20;

/**
 * Hard constraint: push pairs apart until center distance >= minCenterDist.
 * Runs after soft forces so gravity cannot leave nodes overlapping.
 */
function enforceMinCenterSeparation(
  positions: Array<{ id: string; x: number; y: number }>,
  minCenterDist: number,
  rounds = 60,
): void {
  const n = positions.length;
  if (n < 2 || minCenterDist <= 0) return;
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = positions[i]!;
        const b = positions[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-8) {
          dx = (hash01(`${a.id}|${b.id}`) - 0.5) || 0.01;
          dy = (hash01(`${b.id}|${a.id}`) - 0.5) || 0.01;
          dist = Math.hypot(dx, dy) || 0.01;
        }
        if (dist >= minCenterDist) continue;
        const push = (minCenterDist - dist) / 2;
        const ux = (dx / dist) * push;
        const uy = (dy / dist) * push;
        a.x += ux;
        a.y += uy;
        b.x -= ux;
        b.y -= uy;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/**
 * Force-directed layout for one connected component (local XY, centred near origin).
 * Springs + repulsion + gravity → compact “blob” clusters, then a hard min-gap pass.
 */
function forceLayoutComponent(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const n = nodeIds.length;
  const out = new Map<string, { x: number; y: number }>();
  if (n === 0) return out;
  if (n === 1) {
    out.set(nodeIds[0]!, { x: 0, y: 0 });
    return out;
  }

  const ideal = LAYOUT_NODE_W + LAYOUT_NODE_GAP_X; // ~128
  // Soft target during sim; hard pass below uses the same floor.
  const minSep = LAYOUT_NODE_W + LAYOUT_MIN_EDGE_GAP;
  const repulsion = ideal * 1.35;
  const iterations = Math.min(400, 160 + n * 14);

  const idSet = new Set(nodeIds);
  const localEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));

  const radius = Math.max(ideal * 0.85, ideal * 0.4 * Math.sqrt(n));
  const pos = nodeIds.map((id, i) => {
    const base = (2 * Math.PI * i) / n;
    const jitter = (hash01(id) - 0.5) * (Math.PI / Math.max(n, 1));
    const a = base + jitter;
    const r = radius * (0.85 + hash01(`${id}:r`) * 0.3);
    return { id, x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  const index = new Map(pos.map((p, i) => [p.id, i]));

  for (let iter = 0; iter < iterations; iter++) {
    const cooling = 1 - iter / iterations;
    const temp = 12 * cooling + 0.5;
    const fx = new Float64Array(n);
    const fy = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i]!.x - pos[j]!.x;
        let dy = pos[i]!.y - pos[j]!.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-6) {
          dx = (hash01(`${pos[i]!.id}|${pos[j]!.id}`) - 0.5) * 0.01;
          dy = (hash01(`${pos[j]!.id}|${pos[i]!.id}`) - 0.5) * 0.01;
          dist = Math.hypot(dx, dy) || 0.01;
        }
        const rep = (repulsion * repulsion) / (dist * dist);
        // Strong separation so gravity cannot pin nodes on top of each other mid-sim.
        const sep = dist < minSep ? ((minSep - dist) / dist) * 12 : 0;
        const f = rep + sep;
        const ux = (dx / dist) * f;
        const uy = (dy / dist) * f;
        fx[i]! += ux;
        fy[i]! += uy;
        fx[j]! -= ux;
        fy[j]! -= uy;
      }
    }

    for (const e of localEdges) {
      const i = index.get(e.source);
      const j = index.get(e.target);
      if (i == null || j == null || i === j) continue;
      let dx = pos[j]!.x - pos[i]!.x;
      let dy = pos[j]!.y - pos[i]!.y;
      let dist = Math.hypot(dx, dy) || 0.01;
      // Do not pull springs tighter than the hard min gap.
      const springTarget = Math.max(ideal, minSep);
      const f = ((dist - springTarget) / springTarget) * 0.75;
      const ux = (dx / dist) * f;
      const uy = (dy / dist) * f;
      fx[i]! += ux;
      fy[i]! += uy;
      fx[j]! -= ux;
      fy[j]! -= uy;
    }

    // Gravity toward cluster origin — softer than before so min-gap can win.
    const gravity = 0.02 + 0.03 * cooling;
    for (let i = 0; i < n; i++) {
      fx[i]! -= pos[i]!.x * gravity;
      fy[i]! -= pos[i]!.y * gravity;
    }

    for (let i = 0; i < n; i++) {
      let dx = fx[i]!;
      let dy = fy[i]!;
      const mag = Math.hypot(dx, dy);
      if (mag > temp) {
        dx = (dx / mag) * temp;
        dy = (dy / mag) * temp;
      }
      pos[i]!.x += dx;
      pos[i]!.y += dy;
    }
  }

  enforceMinCenterSeparation(pos, minSep);
  for (const p of pos) out.set(p.id, { x: p.x, y: p.y });
  return out;
}

function componentBBox(local: Map<string, { x: number; y: number }>, ids: string[]) {
  const halfW = LAYOUT_NODE_W / 2;
  const halfH = LAYOUT_NODE_H / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const p = local.get(id)!;
    minX = Math.min(minX, p.x - halfW);
    minY = Math.min(minY, p.y - halfH);
    maxX = Math.max(maxX, p.x + halfW);
    maxY = Math.max(maxY, p.y + halfH);
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: LAYOUT_NODE_W, maxY: LAYOUT_NODE_H, w: LAYOUT_NODE_W, h: LAYOUT_NODE_H };
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Clear air between separate connected clusters on one storey. */
const CLUSTER_GAP = LAYOUT_NODE_GAP_X * 1.35;
/** How far outside the cluster hull isolates sit. */
const ISOLATE_MARGIN = LAYOUT_NODE_W * 0.85 + LAYOUT_NODE_GAP_X * 0.5;
/** Gap between room clusters and the stair/lift column on the right. */
const PORTAL_COLUMN_GAP = LAYOUT_NODE_GAP_X * 1.25;
const EXCLUDED_COLUMN_GAP = LAYOUT_NODE_GAP_X * 1.15;
const EXCLUDED_GRID_COLS = 3;

/**
 * Force-layout connected clusters (with gravity), pack them so they never
 * intersect, then sit isolates on a ring around the cluster hull — not inside.
 */
function forceLayoutStorey(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (!nodeIds.length) return out;

  const comps = connectedComponents(nodeIds, edges);
  const clusters = comps.filter((c) => c.length >= 2);
  const isolateIds = comps.filter((c) => c.length === 1).map((c) => c[0]!);

  // No edges at all — small ring / grid of isolates only.
  if (!clusters.length) {
    const n = isolateIds.length;
    if (n === 1) {
      out.set(isolateIds[0]!, { x: 0, y: 0 });
      return out;
    }
    const r = Math.max(LAYOUT_NODE_W + LAYOUT_NODE_GAP_X, 40 * Math.sqrt(n));
    isolateIds.forEach((id, i) => {
      const a = (2 * Math.PI * i) / n + hash01(id) * 0.2;
      out.set(id, { x: Math.cos(a) * r, y: Math.sin(a) * r });
    });
    const ring = [...out.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y }));
    enforceMinCenterSeparation(ring, LAYOUT_NODE_W + LAYOUT_MIN_EDGE_GAP);
    for (const p of ring) out.set(p.id, { x: p.x, y: p.y });
    return out;
  }

  let cursorX = 0;
  let maxH = 0;
  const placed: Array<{
    ids: string[];
    local: Map<string, { x: number; y: number }>;
    bbox: ReturnType<typeof componentBBox>;
    originX: number;
  }> = [];

  for (const ids of clusters) {
    const local = forceLayoutComponent(ids, edges);
    const bbox = componentBBox(local, ids);
    placed.push({ ids, local, bbox, originX: cursorX });
    cursorX += bbox.w + CLUSTER_GAP;
    maxH = Math.max(maxH, bbox.h);
  }

  for (const block of placed) {
    const yPad = (maxH - block.bbox.h) / 2;
    for (const id of block.ids) {
      const p = block.local.get(id)!;
      out.set(id, {
        x: p.x - block.bbox.minX + block.originX,
        y: p.y - block.bbox.minY + yPad,
      });
    }
  }

  // Union hull of all clusters (centers already in `out`).
  let uMinX = Infinity;
  let uMinY = Infinity;
  let uMaxX = -Infinity;
  let uMaxY = -Infinity;
  for (const block of placed) {
    for (const id of block.ids) {
      const p = out.get(id)!;
      uMinX = Math.min(uMinX, p.x - LAYOUT_NODE_W / 2);
      uMinY = Math.min(uMinY, p.y - LAYOUT_NODE_H / 2);
      uMaxX = Math.max(uMaxX, p.x + LAYOUT_NODE_W / 2);
      uMaxY = Math.max(uMaxY, p.y + LAYOUT_NODE_H / 2);
    }
  }
  const cx = (uMinX + uMaxX) / 2;
  const cy = (uMinY + uMaxY) / 2;
  const rx = Math.max((uMaxX - uMinX) / 2 + ISOLATE_MARGIN, LAYOUT_NODE_W * 1.5);
  const ry = Math.max((uMaxY - uMinY) / 2 + ISOLATE_MARGIN, LAYOUT_NODE_H * 1.5);

  // Spread isolates around the outside; prefer right/bottom arc so they don't
  // crowd the label gutter on the left when the band is later placed.
  const nIso = isolateIds.length;
  isolateIds.forEach((id, i) => {
    // Start at ~-50° and sweep ~280° so the left label side stays clearer.
    const t = nIso === 1 ? 0.15 : i / nIso;
    const a = -Math.PI * 0.35 + t * Math.PI * 1.55 + (hash01(id) - 0.5) * 0.25;
    out.set(id, {
      x: cx + Math.cos(a) * rx,
      y: cy + Math.sin(a) * ry,
    });
  });

  // Final storey-wide hard gap (clusters + isolates) so nothing touches.
  const allPos = [...out.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y }));
  enforceMinCenterSeparation(allPos, LAYOUT_NODE_W + LAYOUT_MIN_EDGE_GAP);
  for (const p of allPos) out.set(p.id, { x: p.x, y: p.y });

  return out;
}

/**
 * Level-banded layout: each storey is force-directed; bands stack top→bottom
 * in elevation order with a fixed {@link LAYOUT_BAND_GAP} between levels.
 * Excluded nodes are parked in a grid to the right of stair/lift portals.
 */
export function buildGraphLayout(
  graph: ConnectivityGraph,
  bands: StoreyBand[],
  excludedIds: ReadonlySet<string> = new Set(),
): GraphLayout {
  const display = toDisplayGraph(graph);
  const bandIndex = new Map(bands.map((b, i) => [b.id, i]));
  const nodes: LayoutNode[] = [];

  const spacesByStorey = new Map<string, GraphNode[]>();
  const excludedSpaces: GraphNode[] = [];
  for (const node of display.nodes) {
    if (node.kind !== "space") continue;
    if (excludedIds.has(node.id)) {
      excludedSpaces.push(node);
      continue;
    }
    const raw = node.storey_global_id ?? "__none__";
    const key = bandIndex.has(raw) ? raw : "__none__";
    const list = spacesByStorey.get(key) ?? [];
    list.push(node);
    spacesByStorey.set(key, list);
  }
  for (const list of spacesByStorey.values()) {
    list.sort((a, b) => (a.name || a.global_id).localeCompare(b.name || b.global_id));
  }
  excludedSpaces.sort((a, b) => (a.name || a.global_id).localeCompare(b.name || b.global_id));

  const cellW = LAYOUT_NODE_W + LAYOUT_NODE_GAP_X;
  const cellH = LAYOUT_NODE_H + LAYOUT_NODE_GAP_Y;

  // Intra-storey edges only — vertical links don't pull rooms across floors.
  // Skip anything touching an excluded node so the live network reorganises.
  const undirectedIntra: Array<{ source: string; target: string }> = [];
  const seenIntra = new Set<string>();
  for (const edge of display.edges) {
    if (edge.kind === "vertical") continue;
    if (excludedIds.has(edge.source) || excludedIds.has(edge.target)) continue;
    const a = edge.source < edge.target ? edge.source : edge.target;
    const b = edge.source < edge.target ? edge.target : edge.source;
    const key = `${a}|${b}`;
    if (seenIntra.has(key)) continue;
    seenIntra.add(key);
    undirectedIntra.push({ source: edge.source, target: edge.target });
  }

  type BandPack = {
    band: StoreyBand;
    height: number;
    /** Max right edge of room nodes in band-local coords (top-left system). */
    contentRight: number;
    placements: Array<{ node: GraphNode; x: number; y: number }>;
  };

  const packs: BandPack[] = bands.map((band) => {
    const siblings = spacesByStorey.get(band.id) ?? [];
    if (!siblings.length) {
      return {
        band,
        height: LAYOUT_TOP_PAD + cellH + LAYOUT_BOTTOM_PAD,
        contentRight: 0,
        placements: [],
      };
    }

    const ids = siblings.map((s) => s.id);
    const local = forceLayoutStorey(ids, undirectedIntra);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const p = local.get(id)!;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const halfW = LAYOUT_NODE_W / 2;
    const halfH = LAYOUT_NODE_H / 2;
    minX -= halfW;
    minY -= halfH;
    maxX += halfW;
    maxY += halfH;

    const contentH = Math.max(maxY - minY, LAYOUT_NODE_H);
    const top = siblings.length <= 2 ? 36 : LAYOUT_TOP_PAD;
    const bottom = siblings.length <= 2 ? 28 : LAYOUT_BOTTOM_PAD;
    const height = top + contentH + bottom;

    const placements = siblings.map((node) => {
      const p = local.get(node.id)!;
      return {
        node,
        x: p.x - halfW - minX,
        y: p.y - halfH - minY + top,
      };
    });

    const contentRight = Math.max(0, ...placements.map((p) => p.x + LAYOUT_NODE_W));

    return { band, height, contentRight, placements };
  });

  let yCursor = 0;
  const bandOriginY: number[] = [];
  packs.forEach((pack) => {
    bandOriginY.push(yCursor);
    yCursor += pack.height + LAYOUT_BAND_GAP;
  });

  // Shared right column past the widest storey cluster so stairs never sit on labels.
  const maxClusterRight =
    LAYOUT_GUTTER_X + Math.max(LAYOUT_NODE_W * 2, ...packs.map((p) => p.contentRight));
  const portalColumnX = maxClusterRight + PORTAL_COLUMN_GAP;

  packs.forEach((pack, i) => {
    const originY = bandOriginY[i] ?? 0;
    nodes.push({
      id: `label:${pack.band.id}`,
      kind: "label",
      label: pack.band.label,
      x: 16,
      y: originY + pack.height / 2 - 12,
      w: 140,
      h: 24,
    });

    for (const { node, x, y } of pack.placements) {
      const label = node.name || node.global_id.slice(0, 8);
      nodes.push({
        id: node.id,
        kind: "space",
        label: label.length > 20 ? `${label.slice(0, 18)}…` : label,
        x: LAYOUT_GUTTER_X + x,
        y: originY + y,
        w: LAYOUT_NODE_W,
        h: LAYOUT_NODE_H,
        nestedParent: Boolean(node.nested_parent),
      });
    }
  });

  // Stair / lift portals: right of every level's clusters (never over Level labels).
  const spaceById = new Map(display.nodes.filter((n) => n.kind === "space").map((n) => [n.id, n]));
  const portals = display.nodes.filter(
    (n) => (n.kind === "stair" || n.kind === "lift") && !excludedIds.has(n.id),
  );
  const excludedPortals = display.nodes.filter(
    (n) => (n.kind === "stair" || n.kind === "lift") && excludedIds.has(n.id),
  );
  const portalsByBand = new Map<number, GraphNode[]>();

  for (const portal of portals) {
    let bandIdx: number | null = null;
    const raw = portal.storey_global_id;
    if (raw && bandIndex.has(raw)) {
      bandIdx = bandIndex.get(raw)!;
    } else {
      // Prefer the highest connected storey (top of stack); else last band.
      let bestElev = -Infinity;
      for (const edge of display.edges) {
        const otherId =
          edge.source === portal.id ? edge.target : edge.target === portal.id ? edge.source : null;
        if (!otherId) continue;
        const space = spaceById.get(otherId);
        if (!space) continue;
        const key = space.storey_global_id ?? "__none__";
        const idx = bandIndex.get(key) ?? bandIndex.get("__none__");
        if (idx == null) continue;
        const elev = bands[idx]?.elevation ?? -idx;
        if (elev > bestElev) {
          bestElev = elev;
          bandIdx = idx;
        }
      }
    }
    if (bandIdx == null) bandIdx = Math.max(0, bands.length - 1);
    const list = portalsByBand.get(bandIdx) ?? [];
    list.push(portal);
    portalsByBand.set(bandIdx, list);
  }

  for (const [bandIdx, list] of portalsByBand) {
    list.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    const pack = packs[bandIdx];
    const originY = bandOriginY[bandIdx] ?? 0;
    const bandH = pack?.height ?? cellH;
    const stackGap = 12;
    const totalStack =
      list.length * LAYOUT_PORTAL_H + Math.max(0, list.length - 1) * stackGap;
    let y = originY + Math.max(16, (bandH - totalStack) / 2);
    for (const portal of list) {
      const raw = portal.name || portal.kind;
      nodes.push({
        id: portal.id,
        kind: portal.kind as "stair" | "lift",
        label: raw.length > 16 ? portal.kind : raw,
        x: portalColumnX,
        y,
        w: LAYOUT_PORTAL_W,
        h: LAYOUT_PORTAL_H,
      });
      y += LAYOUT_PORTAL_H + stackGap;
    }
  }

  // Excluded nodes: grid to the right of the stair/lift column (restore via right-click).
  const excludedAll = [...excludedSpaces, ...excludedPortals].sort((a, b) =>
    (a.name || a.id).localeCompare(b.name || b.id),
  );
  if (excludedAll.length) {
    const excludedColumnX = portalColumnX + LAYOUT_PORTAL_W + EXCLUDED_COLUMN_GAP;
    const gapX = LAYOUT_NODE_GAP_X * 0.55;
    const gapY = LAYOUT_NODE_GAP_Y * 0.55;
    const startY = 24;
    excludedAll.forEach((node, i) => {
      const col = i % EXCLUDED_GRID_COLS;
      const row = Math.floor(i / EXCLUDED_GRID_COLS);
      const isPortal = node.kind === "stair" || node.kind === "lift";
      const w = isPortal ? LAYOUT_PORTAL_W : LAYOUT_NODE_W;
      const h = isPortal ? LAYOUT_PORTAL_H : LAYOUT_NODE_H;
      const raw = node.name || node.global_id.slice(0, 8);
      nodes.push({
        id: node.id,
        kind: node.kind as "space" | "stair" | "lift",
        label: raw.length > 20 ? `${raw.slice(0, 18)}…` : raw,
        x: excludedColumnX + col * (LAYOUT_NODE_W + gapX),
        y: startY + row * (LAYOUT_NODE_H + gapY),
        w,
        h,
        excluded: true,
        nestedParent: Boolean(node.nested_parent),
      });
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: LayoutEdge[] = [];
  const seen = new Set<string>();
  for (const edge of display.edges) {
    if (excludedIds.has(edge.source) || excludedIds.has(edge.target)) continue;
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const key = `${edge.source}|${edge.target}`;
    const rev = `${edge.target}|${edge.source}`;
    if (seen.has(key) || seen.has(rev)) continue;
    seen.add(key);
    const inferred =
      Boolean(edge.inferred) || edge.method !== "ifc_rel_space_boundary";
    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      vertical: edge.kind === "vertical",
      inferred,
      heal: healKindForEdge(edge.method, edge.kind, inferred),
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
      edge: "#64748B",
      edgeOpacity: 0.9,
      vertical: "#F59E0B",
      verticalOpacity: 0.55,
      path: "#3B82F6",
      pathNode: "#60A5FA",
      pathUnderlay: "#60A5FA",
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
    edge: "#94A3B8",
    edgeOpacity: 0.95,
    vertical: "#F97316",
    verticalOpacity: 0.55,
    path: "#1D4ED8",
    pathNode: "#2563EB",
    pathUnderlay: "#2563EB",
  };
}

/** @deprecated use graphPalette */
export const cyPalette = graphPalette;
