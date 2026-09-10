/**
 * Per-storey portal navmesh: walkable space footprints linked by graph portals
 * (doors / space↔space). No vertical linking yet.
 */

import { toDisplayGraph } from "@/lib/graph-layout";
import {
  localPathInPolygon,
  pointInSpace,
  wallsOverlappingSpace,
  doorwayVoidsInSpace,
  MinHeap,
} from "@/lib/geometric-path";
import type { FootprintsDocument, Point2D, SpaceFootprint } from "@/types/footprints";
import type { ConnectivityGraph, GraphEdge } from "@/types/graph";

export type NavmeshRegion = {
  spaceId: string;
  globalId: string;
  name: string;
  polygon: Point2D[];
  holes: Point2D[][];
};

export type NavmeshPortal = {
  id: string;
  kind: "door" | "space" | "exit";
  /**
   * For door portals: false = IFC relation door, true = geometry door heal.
   * Space portals are typically inferred openers; unused for colouring today.
   */
  inferred: boolean;
  spaceA: string;
  /**
   * Null for "exit" portals: a door with exactly one linked space (typically
   * an exterior door — the far side isn't a modelled IfcSpace). These are
   * boundary/terminal nodes in the portal graph, not a link between two
   * regions.
   */
  spaceB: string | null;
  /** Plan XY (metres), typically door centre or clear-span portal. */
  point: Point2D;
};

export type StoreyNavmesh = {
  storeyId: string;
  regions: NavmeshRegion[];
  portals: NavmeshPortal[];
};

function polygonCentroid(poly: Point2D[]): Point2D {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(poly.length, 1);
  return { x: x / n, y: y / n };
}

function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** `viz-door:door:GID:space:A:space:B` → door node id. */
export function doorIdFromVizEdge(edgeId: string): string | null {
  if (!edgeId.startsWith("viz-door:")) return null;
  const parts = edgeId.slice("viz-door:".length).split(":");
  if (parts.length >= 6 && parts[0] === "door" && parts[2] === "space" && parts[4] === "space") {
    return `door:${parts[1]}`;
  }
  return null;
}

function spaceOnStorey(
  footprints: FootprintsDocument,
  spaceNodeId: string,
  storeyId: string,
): boolean {
  if (!spaceNodeId.startsWith("space:")) return false;
  const gid = spaceNodeId.slice("space:".length);
  const space = footprints.spaces.find((s) => s.global_id === gid);
  if (!space || space.incomplete || space.polygon.length < 3) return false;
  return space.storey_global_id === storeyId;
}

function portalPointForDisplayEdge(
  footprints: FootprintsDocument,
  graph: ConnectivityGraph,
  edge: GraphEdge & { collapsed?: boolean },
): Point2D | null {
  const doorId = doorIdFromVizEdge(edge.id);
  if (doorId) {
    const gid = doorId.slice("door:".length);
    const door = footprints.doors.find((d) => d.global_id === gid);
    if (door?.point) return { x: door.point.x, y: door.point.y };
    if (door?.segment && door.segment.length >= 2) {
      return midpoint(door.segment[0]!, door.segment[1]!);
    }
  }

  const real = graph.edges.find((e) => e.id === edge.id);
  if (real?.portal && Number.isFinite(real.portal.x) && Number.isFinite(real.portal.y)) {
    return { x: real.portal.x, y: real.portal.y };
  }

  // Any direct graph edge between the same pair with a portal.
  for (const e of graph.edges) {
    const pair =
      (e.source === edge.source && e.target === edge.target) ||
      (e.source === edge.target && e.target === edge.source);
    if (!pair) continue;
    if (e.portal && Number.isFinite(e.portal.x) && Number.isFinite(e.portal.y)) {
      return { x: e.portal.x, y: e.portal.y };
    }
  }

  const aGid = edge.source.startsWith("space:") ? edge.source.slice(6) : null;
  const bGid = edge.target.startsWith("space:") ? edge.target.slice(6) : null;
  const a = aGid ? footprints.spaces.find((s) => s.global_id === aGid) : null;
  const b = bGid ? footprints.spaces.find((s) => s.global_id === bGid) : null;
  if (a && b && a.polygon.length >= 3 && b.polygon.length >= 3) {
    return midpoint(polygonCentroid(a.polygon), polygonCentroid(b.polygon));
  }
  return null;
}

/**
 * Build the walkable mesh for one storey from footprints + the connectivity
 * graph currently shown (doors collapsed to portals; soft-disabled edges skipped).
 */
export function buildStoreyNavmesh(
  footprints: FootprintsDocument,
  graph: ConnectivityGraph,
  storeyId: string,
  opts: {
    excludedNodeIds?: ReadonlySet<string>;
    excludedEdgeIds?: ReadonlySet<string>;
  } = {},
): StoreyNavmesh {
  const excludedNodes = opts.excludedNodeIds ?? new Set<string>();
  const excludedEdges = opts.excludedEdgeIds ?? new Set<string>();

  const regions: NavmeshRegion[] = [];
  for (const space of footprints.spaces) {
    if (space.storey_global_id !== storeyId) continue;
    if (space.incomplete || space.polygon.length < 3) continue;
    const spaceId = `space:${space.global_id}`;
    if (excludedNodes.has(spaceId)) continue;
    regions.push({
      spaceId,
      globalId: space.global_id,
      name: space.name || space.global_id,
      polygon: space.polygon,
      holes: space.holes ?? [],
    });
  }

  const regionIds = new Set(regions.map((r) => r.spaceId));
  const display = toDisplayGraph(graph);
  const portals: NavmeshPortal[] = [];
  const seen = new Set<string>();

  for (const edge of display.edges) {
    if (edge.kind === "vertical") continue;
    if (excludedEdges.has(edge.id)) continue;
    if (excludedNodes.has(edge.source) || excludedNodes.has(edge.target)) continue;
    if (!regionIds.has(edge.source) || !regionIds.has(edge.target)) continue;
    if (!spaceOnStorey(footprints, edge.source, storeyId)) continue;
    if (!spaceOnStorey(footprints, edge.target, storeyId)) continue;

    const a = edge.source < edge.target ? edge.source : edge.target;
    const b = edge.source < edge.target ? edge.target : edge.source;
    const key = `${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const point = portalPointForDisplayEdge(footprints, graph, edge);
    if (!point) continue;

    const kind: NavmeshPortal["kind"] =
      edge.kind === "space_door" || edge.id.startsWith("viz-door:") || Boolean(edge.collapsed)
        ? "door"
        : "space";

    const inferred =
      Boolean(edge.inferred) ||
      edge.method === "geom_door_space" ||
      edge.method === "geom_opening_space" ||
      (kind === "door" && edge.method !== "ifc_rel_space_boundary");

    portals.push({
      id: edge.id,
      kind,
      inferred,
      spaceA: a,
      spaceB: b,
      point,
    });
  }

  // Doors with exactly one linked space (typically exterior doors — the far
  // side isn't a modelled IfcSpace) become boundary "exit" portals: terminal
  // nodes in the portal graph rather than a link between two regions. These
  // never appear in `display.edges` above (its door-collapsing loop only
  // pushes an edge when a door links >= 2 spaces), which is the gap this
  // closes.
  const spacesByDoor = new Map<string, string[]>();
  const doorInferredBySpace = new Map<string, Map<string, boolean>>();
  for (const edge of graph.edges) {
    if (edge.kind !== "space_door") continue;
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
    if (!doorId || !spaceId) continue;
    const list = spacesByDoor.get(doorId) ?? [];
    if (!list.includes(spaceId)) list.push(spaceId);
    spacesByDoor.set(doorId, list);

    const inferred =
      Boolean(edge.inferred) ||
      edge.method === "geom_door_space" ||
      edge.method !== "ifc_rel_space_boundary";
    const bySpace = doorInferredBySpace.get(doorId) ?? new Map<string, boolean>();
    bySpace.set(spaceId, Boolean(bySpace.get(spaceId)) || inferred);
    doorInferredBySpace.set(doorId, bySpace);
  }

  for (const [doorId, spaces] of spacesByDoor) {
    if (spaces.length !== 1) continue;
    const spaceId = spaces[0]!;
    if (!regionIds.has(spaceId)) continue;
    if (excludedNodes.has(doorId) || excludedNodes.has(spaceId)) continue;
    if (!spaceOnStorey(footprints, spaceId, storeyId)) continue;

    const id = `viz-exit:${doorId}:${spaceId}`;
    if (excludedEdges.has(id)) continue;

    const gid = doorId.slice("door:".length);
    const door = footprints.doors.find((d) => d.global_id === gid);
    let point: Point2D | null = null;
    if (door?.point) point = { x: door.point.x, y: door.point.y };
    else if (door?.segment && door.segment.length >= 2) {
      point = midpoint(door.segment[0]!, door.segment[1]!);
    }
    if (!point) continue;

    portals.push({
      id,
      kind: "exit",
      inferred: Boolean(doorInferredBySpace.get(doorId)?.get(spaceId)),
      spaceA: spaceId,
      spaceB: null,
      point,
    });
  }

  return { storeyId, regions, portals };
}

/** Every storey that has walkable regions (for stacked 3D display). */
export function buildAllStoreyNavmeshes(
  footprints: FootprintsDocument,
  graph: ConnectivityGraph,
  opts: {
    excludedNodeIds?: ReadonlySet<string>;
    excludedEdgeIds?: ReadonlySet<string>;
  } = {},
): StoreyNavmesh[] {
  const storeyIds = new Set<string>();
  for (const space of footprints.spaces) {
    if (space.incomplete || space.polygon.length < 3 || !space.storey_global_id) continue;
    storeyIds.add(space.storey_global_id);
  }
  const ordered = (footprints.storeys ?? [])
    .map((s) => s.global_id)
    .filter((id) => storeyIds.has(id));
  for (const id of storeyIds) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered
    .map((id) => buildStoreyNavmesh(footprints, graph, id, opts))
    .filter((m) => m.regions.length > 0);
}

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Region containing a plan point, if any. */
export function regionAtPoint(
  mesh: StoreyNavmesh,
  point: Point2D,
): NavmeshRegion | null {
  for (const r of mesh.regions) {
    if (pointInSpace(point.x, point.y, r.polygon, r.holes)) return r;
  }
  return null;
}

function spaceFootprintForRegion(
  footprints: FootprintsDocument | null | undefined,
  region: NavmeshRegion,
): SpaceFootprint | null {
  if (!footprints) return null;
  return footprints.spaces.find((s) => s.global_id === region.globalId) ?? null;
}

function localWalk(
  start: Point2D,
  goal: Point2D,
  region: NavmeshRegion,
  footprints: FootprintsDocument | null | undefined,
): Point2D[] {
  const space = spaceFootprintForRegion(footprints, region);
  if (space && footprints) {
    const obstacles = wallsOverlappingSpace(footprints, space);
    const voids = doorwayVoidsInSpace(footprints, space);
    return localPathInPolygon(
      start,
      goal,
      region.polygon,
      region.holes,
      obstacles,
      voids,
    );
  }
  return localPathInPolygon(start, goal, region.polygon, region.holes);
}

type PortalGraphNode = { id: string; point: Point2D; regions: string[]; isExit?: boolean };

type PortalGraph = {
  nodes: Map<string, PortalGraphNode>;
  adjacency: Map<string, { id: string; viaRegion: string; cost: number }[]>;
};

/**
 * Shared portal-graph builder for `findNavmeshPath` and `findNearestExitPath`:
 * one node per extra point (click targets) plus every non-blocked portal,
 * bucketed by region so adjacency is built once in O(V) rather than an O(V^2)
 * per-node rescan (a portal-dense storey can have hundreds of doors).
 */
function buildPortalGraph(
  mesh: StoreyNavmesh,
  extraNodes: PortalGraphNode[],
  blockedPortalIds?: ReadonlySet<string>,
): PortalGraph {
  const nodes = new Map<string, PortalGraphNode>();
  for (const n of extraNodes) nodes.set(n.id, n);
  for (const p of mesh.portals) {
    if (blockedPortalIds?.has(p.id)) continue;
    nodes.set(p.id, {
      id: p.id,
      point: p.point,
      regions: p.spaceB ? [p.spaceA, p.spaceB] : [p.spaceA],
      isExit: p.kind === "exit",
    });
  }

  const nodesByRegion = new Map<string, PortalGraphNode[]>();
  for (const node of nodes.values()) {
    for (const regionId of node.regions) {
      const list = nodesByRegion.get(regionId) ?? [];
      list.push(node);
      nodesByRegion.set(regionId, list);
    }
  }
  const adjacency = new Map<string, { id: string; viaRegion: string; cost: number }[]>();
  for (const node of nodes.values()) {
    const out: { id: string; viaRegion: string; cost: number }[] = [];
    const linked = new Set<string>();
    // First of this node's own regions (in order) that the other node also
    // belongs to — stable tie-break, independent of Map iteration order.
    for (const regionId of node.regions) {
      for (const other of nodesByRegion.get(regionId) ?? []) {
        if (other.id === node.id || linked.has(other.id)) continue;
        linked.add(other.id);
        out.push({ id: other.id, viaRegion: regionId, cost: dist(node.point, other.point) });
      }
    }
    adjacency.set(node.id, out);
  }

  return { nodes, adjacency };
}

/** Reconstructs the walkable point sequence for a portal-graph path via `cameFrom`. */
function stitchPortalPath(
  graph: PortalGraph,
  regionById: Map<string, NavmeshRegion>,
  cameFrom: Map<string, { prev: string; viaRegion: string }>,
  start: Point2D,
  startId: string,
  endId: string,
  footprints: FootprintsDocument | null | undefined,
): { points: Point2D[]; hops: number } | null {
  const chain: { id: string; viaRegion: string }[] = [];
  let cur = endId;
  while (cur !== startId) {
    const step = cameFrom.get(cur);
    if (!step) return null;
    chain.push({ id: cur, viaRegion: step.viaRegion });
    cur = step.prev;
  }
  chain.reverse();

  const points: Point2D[] = [];
  let fromPt = start;
  for (const step of chain) {
    const toNode = graph.nodes.get(step.id)!;
    const region = regionById.get(step.viaRegion);
    if (!region) return null;
    const seg = localWalk(fromPt, toNode.point, region, footprints);
    if (!seg.length) return null;
    if (points.length) {
      // Avoid duplicating the shared portal vertex.
      points.push(...seg.slice(1));
    } else {
      points.push(...seg);
    }
    fromPt = toNode.point;
  }
  return { points, hops: chain.length };
}

/**
 * Click-to-click A* on a portal navmesh.
 * Same region → local grid A*. Different regions → A* over portals, then
 * stitch with local A* through each intervening space.
 */
export function findNavmeshPath(
  mesh: StoreyNavmesh,
  start: Point2D,
  end: Point2D,
  footprints?: FootprintsDocument | null,
  opts: { blockedPortalIds?: ReadonlySet<string> } = {},
): { found: boolean; points: Point2D[]; note: string } {
  const startRegion = regionAtPoint(mesh, start);
  const endRegion = regionAtPoint(mesh, end);
  if (!startRegion || !endRegion) {
    return { found: false, points: [], note: "Pick points inside walkable regions" };
  }

  if (startRegion.spaceId === endRegion.spaceId) {
    const points = localWalk(start, end, startRegion, footprints);
    return {
      found: points.length > 0,
      points,
      note: points.length ? "Same-region path" : "No path in region",
    };
  }

  const regionById = new Map(mesh.regions.map((r) => [r.spaceId, r]));
  const graph = buildPortalGraph(
    mesh,
    [
      { id: "__start", point: start, regions: [startRegion.spaceId] },
      { id: "__end", point: end, regions: [endRegion.spaceId] },
    ],
    opts.blockedPortalIds,
  );

  // A* over the portal graph (euclidean edge costs), binary-heap open set —
  // re-pushes a cheaper route instead of mutating an open entry, so stale
  // entries are skipped via `closed` on pop (no decrease-key needed).
  const cameFrom = new Map<string, { prev: string; viaRegion: string }>();
  const gScore = new Map<string, number>([["__start", 0]]);
  const open = new MinHeap<{ id: string; f: number }>((a, b) => a.f < b.f);
  open.push({ id: "__start", f: dist(start, end) });
  const closed = new Set<string>();

  let foundEnd = false;
  while (open.size) {
    const current = open.pop()!;
    if (closed.has(current.id)) continue;
    closed.add(current.id);
    if (current.id === "__end") {
      foundEnd = true;
      break;
    }
    const gCur = gScore.get(current.id) ?? Infinity;
    for (const n of graph.adjacency.get(current.id) ?? []) {
      const tentative = gCur + n.cost;
      if (tentative >= (gScore.get(n.id) ?? Infinity)) continue;
      cameFrom.set(n.id, { prev: current.id, viaRegion: n.viaRegion });
      gScore.set(n.id, tentative);
      const nb = graph.nodes.get(n.id)!;
      open.push({ id: n.id, f: tentative + dist(nb.point, end) });
    }
  }

  if (!foundEnd) {
    return { found: false, points: [], note: "No portal path between regions" };
  }

  const stitched = stitchPortalPath(
    graph,
    regionById,
    cameFrom,
    start,
    "__start",
    "__end",
    footprints,
  );
  if (!stitched) {
    return { found: false, points: [], note: "Path reconstruction failed" };
  }

  return {
    found: stitched.points.length >= 2,
    points: stitched.points,
    note: `${stitched.hops} hops`,
  };
}

/**
 * Multi-target Dijkstra from `start` to the nearest reachable "exit" portal
 * (a boundary door with no modelled space on the far side — see
 * {@link NavmeshPortal}). Used for emergency "nearest way out" routing rather
 * than a specific click-to-click destination.
 */
export function findNearestExitPath(
  mesh: StoreyNavmesh,
  start: Point2D,
  footprints?: FootprintsDocument | null,
  opts: { blockedPortalIds?: ReadonlySet<string> } = {},
): { found: boolean; points: Point2D[]; note: string; exitPortalId?: string } {
  const startRegion = regionAtPoint(mesh, start);
  if (!startRegion) {
    return { found: false, points: [], note: "Pick a point inside a walkable region" };
  }

  const hasExit = mesh.portals.some((p) => p.kind === "exit" && !opts.blockedPortalIds?.has(p.id));
  if (!hasExit) {
    return { found: false, points: [], note: "No exit portal on this storey" };
  }

  const regionById = new Map(mesh.regions.map((r) => [r.spaceId, r]));
  const graph = buildPortalGraph(
    mesh,
    [{ id: "__start", point: start, regions: [startRegion.spaceId] }],
    opts.blockedPortalIds,
  );

  // Plain Dijkstra (no heuristic — there's no single fixed goal point).
  const cameFrom = new Map<string, { prev: string; viaRegion: string }>();
  const gScore = new Map<string, number>([["__start", 0]]);
  const open = new MinHeap<{ id: string; g: number }>((a, b) => a.g < b.g);
  open.push({ id: "__start", g: 0 });
  const closed = new Set<string>();

  let exitId: string | null = null;
  while (open.size) {
    const current = open.pop()!;
    if (closed.has(current.id)) continue;
    closed.add(current.id);
    const node = graph.nodes.get(current.id)!;
    if (node.isExit) {
      exitId = current.id;
      break;
    }
    const gCur = gScore.get(current.id) ?? Infinity;
    for (const n of graph.adjacency.get(current.id) ?? []) {
      const tentative = gCur + n.cost;
      if (tentative >= (gScore.get(n.id) ?? Infinity)) continue;
      cameFrom.set(n.id, { prev: current.id, viaRegion: n.viaRegion });
      gScore.set(n.id, tentative);
      open.push({ id: n.id, g: tentative });
    }
  }

  if (!exitId) {
    return { found: false, points: [], note: "No reachable exit" };
  }

  if (exitId === "__start") {
    return { found: true, points: [start], note: "Already at an exit", exitPortalId: exitId };
  }

  const stitched = stitchPortalPath(
    graph,
    regionById,
    cameFrom,
    start,
    "__start",
    exitId,
    footprints,
  );
  if (!stitched) {
    return { found: false, points: [], note: "Path reconstruction failed" };
  }

  return {
    found: stitched.points.length >= 2,
    points: stitched.points,
    note: `${stitched.hops} hops to exit`,
    exitPortalId: exitId,
  };
}

/** Distance from point to polyline (for right-click hit testing). */
export function distToPolyline(point: Point2D, poly: Point2D[]): number {
  if (poly.length === 0) return Infinity;
  if (poly.length === 1) return dist(point, poly[0]!);
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = point.x - a.x;
    const apy = point.y - a.y;
    const ab2 = abx * abx + aby * aby;
    const t = ab2 < 1e-18 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
    best = Math.min(best, Math.hypot(point.x - (a.x + abx * t), point.y - (a.y + aby * t)));
  }
  return best;
}
