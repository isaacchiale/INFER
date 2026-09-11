/**
 * Per-storey portal navmesh: walkable space footprints linked by graph portals
 * (doors / space↔space), plus engine-level cross-storey routing via
 * {@link findMultiStoreyNavmeshPath} over the same stair/lift "vertical"
 * connectors the backend heals per floor.
 */

import { toDisplayGraph } from "@/lib/graph-layout";
import {
  localPathInPolygon,
  pointInSpace,
  wallsOverlappingSpace,
  furnitureOverlappingSpace,
  doorwayVoidsInSpace,
  hasLineOfSight,
  MinHeap,
} from "@/lib/geometric-path";
import type { DoorPortal, FootprintsDocument, Point2D, SpaceFootprint } from "@/types/footprints";
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
  /**
   * global_id of the underlying door (DoorFootprint), for "door"/"exit"
   * portals that trace back to an actual IfcDoor — lets the UI look up the
   * door's own segment/normal/operation_type (e.g. for a supplementary swing
   * glyph) without re-parsing portal ids. Null for "space" portals (no door)
   * and any portal whose source door id couldn't be resolved.
   */
  doorGlobalId: string | null;
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

function spacesById(footprints: FootprintsDocument): Map<string, SpaceFootprint> {
  const map = new Map<string, SpaceFootprint>();
  for (const s of footprints.spaces) map.set(s.global_id, s);
  return map;
}

function doorsByGlobalId(footprints: FootprintsDocument): Map<string, DoorPortal> {
  const map = new Map<string, DoorPortal>();
  for (const d of footprints.doors) map.set(d.global_id, d);
  return map;
}

/** Sorted "a|b" key so either edge direction maps to the same bucket. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function edgesById(graph: ConnectivityGraph): Map<string, GraphEdge> {
  const map = new Map<string, GraphEdge>();
  for (const e of graph.edges) map.set(e.id, e);
  return map;
}

function edgesByPairKey(graph: ConnectivityGraph): Map<string, GraphEdge[]> {
  const map = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const key = pairKey(e.source, e.target);
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  }
  return map;
}

function spaceOnStorey(
  spaceById: Map<string, SpaceFootprint>,
  spaceNodeId: string,
  storeyId: string,
): boolean {
  if (!spaceNodeId.startsWith("space:")) return false;
  const gid = spaceNodeId.slice("space:".length);
  const space = spaceById.get(gid);
  if (!space || space.incomplete || space.polygon.length < 3) return false;
  return space.storey_global_id === storeyId;
}

function portalPointForDisplayEdge(
  edge: GraphEdge & { collapsed?: boolean },
  doorById: Map<string, DoorPortal>,
  edgeById: Map<string, GraphEdge>,
  edgesByPair: Map<string, GraphEdge[]>,
  spaceById: Map<string, SpaceFootprint>,
): Point2D | null {
  const doorId = doorIdFromVizEdge(edge.id);
  if (doorId) {
    const gid = doorId.slice("door:".length);
    const door = doorById.get(gid);
    if (door?.point) return { x: door.point.x, y: door.point.y };
    if (door?.segment && door.segment.length >= 2) {
      return midpoint(door.segment[0]!, door.segment[1]!);
    }
  }

  const real = edgeById.get(edge.id);
  if (real?.portal && Number.isFinite(real.portal.x) && Number.isFinite(real.portal.y)) {
    return { x: real.portal.x, y: real.portal.y };
  }

  // Any direct graph edge between the same pair with a portal.
  for (const e of edgesByPair.get(pairKey(edge.source, edge.target)) ?? []) {
    if (e.portal && Number.isFinite(e.portal.x) && Number.isFinite(e.portal.y)) {
      return { x: e.portal.x, y: e.portal.y };
    }
  }

  const aGid = edge.source.startsWith("space:") ? edge.source.slice(6) : null;
  const bGid = edge.target.startsWith("space:") ? edge.target.slice(6) : null;
  const a = aGid ? spaceById.get(aGid) : null;
  const b = bGid ? spaceById.get(bGid) : null;
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
    /**
     * Precomputed by callers that build meshes for every storey in one pass
     * (e.g. buildAllStoreyNavmeshes) — toDisplayGraph's result doesn't depend
     * on storeyId, so recomputing it per storey would redo the same full
     * graph pass N times for an N-storey building.
     */
    display?: ReturnType<typeof toDisplayGraph>;
    spaceById?: Map<string, SpaceFootprint>;
    doorById?: Map<string, DoorPortal>;
    edgeById?: Map<string, GraphEdge>;
    edgesByPair?: Map<string, GraphEdge[]>;
  } = {},
): StoreyNavmesh {
  const excludedNodes = opts.excludedNodeIds ?? new Set<string>();
  const excludedEdges = opts.excludedEdgeIds ?? new Set<string>();
  const spaceById = opts.spaceById ?? spacesById(footprints);
  const doorById = opts.doorById ?? doorsByGlobalId(footprints);
  const edgeById = opts.edgeById ?? edgesById(graph);
  const edgesByPair = opts.edgesByPair ?? edgesByPairKey(graph);

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
  const display = opts.display ?? toDisplayGraph(graph);
  const portals: NavmeshPortal[] = [];
  const seen = new Set<string>();

  for (const edge of display.edges) {
    if (edge.kind === "vertical") continue;
    if (excludedEdges.has(edge.id)) continue;
    if (excludedNodes.has(edge.source) || excludedNodes.has(edge.target)) continue;
    if (!regionIds.has(edge.source) || !regionIds.has(edge.target)) continue;
    if (!spaceOnStorey(spaceById, edge.source, storeyId)) continue;
    if (!spaceOnStorey(spaceById, edge.target, storeyId)) continue;

    const a = edge.source < edge.target ? edge.source : edge.target;
    const b = edge.source < edge.target ? edge.target : edge.source;
    const key = `${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const point = portalPointForDisplayEdge(edge, doorById, edgeById, edgesByPair, spaceById);
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
      doorGlobalId:
        kind === "door" ? (doorIdFromVizEdge(edge.id)?.slice("door:".length) ?? null) : null,
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
    if (!spaceOnStorey(spaceById, spaceId, storeyId)) continue;

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
      doorGlobalId: gid,
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
  // Computed once and shared across storeys: none of these depend on
  // storeyId, so recomputing them per storey would redo the same full
  // graph/footprints pass N times for an N-storey building, and the .find()
  // scans they replace turn each portal lookup into O(1) map gets.
  const display = toDisplayGraph(graph);
  const spaceById = spacesById(footprints);
  const doorById = doorsByGlobalId(footprints);
  const edgeById = edgesById(graph);
  const edgesByPair = edgesByPairKey(graph);
  return ordered
    .map((id) =>
      buildStoreyNavmesh(footprints, graph, id, {
        ...opts,
        display,
        spaceById,
        doorById,
        edgeById,
        edgesByPair,
      }),
    )
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
    const obstacles = [
      ...wallsOverlappingSpace(footprints, space),
      ...furnitureOverlappingSpace(footprints, space),
    ];
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

function pathLength(points: Point2D[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1]!, points[i]!);
  return total;
}

/** Obstacle/doorway-void geometry a region's local pathing needs, computed once per region and reused. */
function regionGeometry(
  region: NavmeshRegion,
  footprints: FootprintsDocument | null | undefined,
): { obstacles: Point2D[][]; voids: Point2D[][] } {
  const space = spaceFootprintForRegion(footprints, region);
  if (!space || !footprints) return { obstacles: [], voids: [] };
  return {
    obstacles: [
      ...wallsOverlappingSpace(footprints, space),
      ...furnitureOverlappingSpace(footprints, space),
    ],
    voids: doorwayVoidsInSpace(footprints, space),
  };
}

/**
 * Edge cost between two points that share a walkable region: straight-line
 * distance when there's a clear line of sight between them (the common
 * case — cheap and exact, since there's genuinely no detour needed), or the
 * true local-A* walking distance when something in the room blocks that
 * line. Straight-line distance always UNDERESTIMATES the real cost of
 * detouring around an obstacle, so without this, the portal-graph search
 * (and "nearest exit" search) could judge a route "shortest" using a chord
 * through furniture/a column it can't actually walk through, while the
 * rendered path — already obstacle-aware via `localWalk` — comes out
 * longer than the graph thought when picking between routes.
 */
function traversalCost(
  a: Point2D,
  b: Point2D,
  region: NavmeshRegion,
  obstacles: Point2D[][],
  voids: Point2D[][],
): number {
  const straight = dist(a, b);
  if (!obstacles.length) return straight;
  if (hasLineOfSight(a, b, region.polygon, region.holes, obstacles, voids)) return straight;
  return pathLength(localPathInPolygon(a, b, region.polygon, region.holes, obstacles, voids));
}

/**
 * Shared portal-graph builder for `findNavmeshPath` and `findNearestExitPath`:
 * one node per extra point (click targets) plus every non-blocked portal,
 * bucketed by region so adjacency is built once in O(V) rather than an O(V^2)
 * per-node rescan (a portal-dense storey can have hundreds of doors). Edge
 * costs come from `traversalCost` above; region obstacle/void geometry is
 * computed once per region (not once per edge — wallsOverlappingSpace scans
 * every wall in the model, and an edge-per-call cost would turn this back
 * into an O(V x walls) rescan).
 */
function buildPortalGraph(
  mesh: StoreyNavmesh,
  regionById: Map<string, NavmeshRegion>,
  extraNodes: PortalGraphNode[],
  footprints: FootprintsDocument | null | undefined,
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
  const geomByRegion = new Map<string, { obstacles: Point2D[][]; voids: Point2D[][] }>();
  const geometryFor = (regionId: string, region: NavmeshRegion) => {
    let g = geomByRegion.get(regionId);
    if (!g) {
      g = regionGeometry(region, footprints);
      geomByRegion.set(regionId, g);
    }
    return g;
  };

  const adjacency = new Map<string, { id: string; viaRegion: string; cost: number }[]>();
  for (const node of nodes.values()) {
    const out: { id: string; viaRegion: string; cost: number }[] = [];
    const linked = new Set<string>();
    // First of this node's own regions (in order) that the other node also
    // belongs to — stable tie-break, independent of Map iteration order.
    for (const regionId of node.regions) {
      const region = regionById.get(regionId);
      for (const other of nodesByRegion.get(regionId) ?? []) {
        if (other.id === node.id || linked.has(other.id)) continue;
        linked.add(other.id);
        let cost = dist(node.point, other.point);
        if (region) {
          const { obstacles, voids } = geometryFor(regionId, region);
          cost = traversalCost(node.point, other.point, region, obstacles, voids);
        }
        out.push({ id: other.id, viaRegion: regionId, cost });
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
    regionById,
    [
      { id: "__start", point: start, regions: [startRegion.spaceId] },
      { id: "__end", point: end, regions: [endRegion.spaceId] },
    ],
    footprints,
    opts.blockedPortalIds,
  );

  // A* over the portal graph (obstacle-aware edge costs — see
  // `traversalCost`), binary-heap open set — re-pushes a cheaper route
  // instead of mutating an open entry, so stale entries are skipped via
  // `closed` on pop (no decrease-key needed).
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
    regionById,
    [{ id: "__start", point: start, regions: [startRegion.spaceId] }],
    footprints,
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

export type VerticalConnector = {
  /** Stair/lift graph node id, e.g. "stair:GID" or "lift:GID". */
  linkId: string;
  storeyId: string;
  spaceId: string;
  point: Point2D;
};

/**
 * Groups "vertical" graph edges (stair/lift ↔ space, one per storey the
 * backend healed it onto — see graph_geometry.py's `heal_storeys` loop) by
 * stair/lift id, so the same physical stair/lift can bridge storeys in a
 * cross-floor portal graph.
 */
export function buildVerticalConnectors(
  graph: ConnectivityGraph,
  footprints: FootprintsDocument,
): Map<string, VerticalConnector[]> {
  const out = new Map<string, VerticalConnector[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "vertical") continue;
    const linkId =
      edge.source.startsWith("stair:") || edge.source.startsWith("lift:")
        ? edge.source
        : edge.target.startsWith("stair:") || edge.target.startsWith("lift:")
          ? edge.target
          : null;
    const spaceId = edge.source.startsWith("space:")
      ? edge.source
      : edge.target.startsWith("space:")
        ? edge.target
        : null;
    if (!linkId || !spaceId) continue;

    const gid = spaceId.slice("space:".length);
    const space = footprints.spaces.find((s) => s.global_id === gid);
    if (!space || space.incomplete || space.polygon.length < 3 || !space.storey_global_id) continue;

    const list = out.get(linkId) ?? [];
    if (list.some((c) => c.storeyId === space.storey_global_id)) continue;
    list.push({
      linkId,
      storeyId: space.storey_global_id,
      spaceId,
      point: polygonCentroid(space.polygon),
    });
    out.set(linkId, list);
  }
  return out;
}

/** Fallback vertical-hop cost (plan-distance units) when storey elevation data is missing. */
const VERTICAL_HOP_FALLBACK_COST = 4;

function verticalHopCost(
  footprints: FootprintsDocument | null | undefined,
  storeyA: string,
  storeyB: string,
): number {
  const elevA = footprints?.storeys?.find((s) => s.global_id === storeyA)?.elevation;
  const elevB = footprints?.storeys?.find((s) => s.global_id === storeyB)?.elevation;
  if (elevA == null || elevB == null || !Number.isFinite(elevA) || !Number.isFinite(elevB)) {
    return VERTICAL_HOP_FALLBACK_COST;
  }
  return Math.max(Math.abs(elevA - elevB), 1);
}

/**
 * Cross-storey Dijkstra: routes between two storeys' meshes through
 * whichever stair/lift {@link VerticalConnector}s bridge them. Engine-level
 * only — not wired into the click-to-click floorplan UI, which stays
 * per-storey (see {@link findNavmeshPath}); a caller wanting multi-floor
 * evacuation routing (e.g. "nearest exit, any floor") composes this with its
 * own storey-selection UI.
 *
 * `blockedConnectorIds` keys are `${linkId}@${storeyId}` (one entry per
 * storey a stair/lift touches, since a hazard can block one landing without
 * blocking the whole stair).
 */
export function findMultiStoreyNavmeshPath(
  meshes: StoreyNavmesh[],
  graph: ConnectivityGraph,
  footprints: FootprintsDocument,
  start: { storeyId: string; point: Point2D },
  end: { storeyId: string; point: Point2D },
  opts: { blockedPortalIds?: ReadonlySet<string>; blockedConnectorIds?: ReadonlySet<string> } = {},
): { found: boolean; note: string; segments: { storeyId: string; points: Point2D[] }[] } {
  const meshById = new Map(meshes.map((m) => [m.storeyId, m]));
  const startMesh = meshById.get(start.storeyId);
  const endMesh = meshById.get(end.storeyId);
  if (!startMesh || !endMesh) {
    return { found: false, note: "Unknown storey", segments: [] };
  }
  const startRegion = regionAtPoint(startMesh, start.point);
  const endRegion = regionAtPoint(endMesh, end.point);
  if (!startRegion || !endRegion) {
    return { found: false, note: "Pick points inside walkable regions", segments: [] };
  }

  if (start.storeyId === end.storeyId) {
    const sameStoreyOpts = opts.blockedPortalIds ? { blockedPortalIds: opts.blockedPortalIds } : {};
    const result = findNavmeshPath(startMesh, start.point, end.point, footprints, sameStoreyOpts);
    return {
      found: result.found,
      note: result.note,
      segments: result.found ? [{ storeyId: start.storeyId, points: result.points }] : [],
    };
  }

  const regionByIdPerStorey = new Map<string, Map<string, NavmeshRegion>>();
  for (const mesh of meshes) {
    regionByIdPerStorey.set(mesh.storeyId, new Map(mesh.regions.map((r) => [r.spaceId, r])));
  }

  type MultiNode = { id: string; storeyId: string; point: Point2D; regions: string[] };
  const nodes = new Map<string, MultiNode>();
  nodes.set("__start", {
    id: "__start",
    storeyId: start.storeyId,
    point: start.point,
    regions: [startRegion.spaceId],
  });
  nodes.set("__end", {
    id: "__end",
    storeyId: end.storeyId,
    point: end.point,
    regions: [endRegion.spaceId],
  });
  for (const mesh of meshes) {
    for (const p of mesh.portals) {
      if (opts.blockedPortalIds?.has(p.id)) continue;
      nodes.set(p.id, {
        id: p.id,
        storeyId: mesh.storeyId,
        point: p.point,
        regions: p.spaceB ? [p.spaceA, p.spaceB] : [p.spaceA],
      });
    }
  }

  // One node per (stair/lift, storey) landing; grouped so every pair on the
  // same stair/lift can be linked below (a lift may bridge more than two
  // storeys, not just consecutive ones).
  const connectorsByLink = buildVerticalConnectors(graph, footprints);
  const connectorNodeIdsByLink = new Map<string, string[]>();
  for (const [linkId, connectors] of connectorsByLink) {
    for (const c of connectors) {
      if (!meshById.has(c.storeyId)) continue;
      if (!regionByIdPerStorey.get(c.storeyId)?.has(c.spaceId)) continue;
      const connectorKey = `${linkId}@${c.storeyId}`;
      if (opts.blockedConnectorIds?.has(connectorKey)) continue;

      const id = `vlink:${connectorKey}`;
      nodes.set(id, { id, storeyId: c.storeyId, point: c.point, regions: [c.spaceId] });
      const list = connectorNodeIdsByLink.get(linkId) ?? [];
      list.push(id);
      connectorNodeIdsByLink.set(linkId, list);
    }
  }

  // Same-storey adjacency: bucket nodes by region id (space ids are globally
  // unique, so no need to also key by storey) — same O(V) approach as
  // {@link buildPortalGraph}. `viaRegion: null` marks a cross-storey hop,
  // stitched below as a discrete vertical transition rather than a local walk.
  const nodesByRegion = new Map<string, MultiNode[]>();
  for (const node of nodes.values()) {
    for (const regionId of node.regions) {
      const list = nodesByRegion.get(regionId) ?? [];
      list.push(node);
      nodesByRegion.set(regionId, list);
    }
  }
  // Same-region obstacle/void geometry, computed once per region and reused
  // across every edge that crosses it — see `traversalCost` / `buildPortalGraph`.
  const geomByRegion = new Map<string, { obstacles: Point2D[][]; voids: Point2D[][] }>();
  const geometryFor = (regionId: string, region: NavmeshRegion) => {
    let g = geomByRegion.get(regionId);
    if (!g) {
      g = regionGeometry(region, footprints);
      geomByRegion.set(regionId, g);
    }
    return g;
  };

  const adjacency = new Map<string, { id: string; viaRegion: string | null; cost: number }[]>();
  for (const node of nodes.values()) {
    const out: { id: string; viaRegion: string | null; cost: number }[] = [];
    const linked = new Set<string>();
    for (const regionId of node.regions) {
      // node.storeyId === other.storeyId is guaranteed here: space ids are
      // globally unique, so two nodes sharing a regionId share a storey too.
      const region = regionByIdPerStorey.get(node.storeyId)?.get(regionId);
      for (const other of nodesByRegion.get(regionId) ?? []) {
        if (other.id === node.id || linked.has(other.id)) continue;
        linked.add(other.id);
        let cost = dist(node.point, other.point);
        if (region) {
          const { obstacles, voids } = geometryFor(regionId, region);
          cost = traversalCost(node.point, other.point, region, obstacles, voids);
        }
        out.push({ id: other.id, viaRegion: regionId, cost });
      }
    }
    adjacency.set(node.id, out);
  }
  for (const nodeIds of connectorNodeIdsByLink.values()) {
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const a = nodes.get(nodeIds[i]!)!;
        const b = nodes.get(nodeIds[j]!)!;
        const cost = verticalHopCost(footprints, a.storeyId, b.storeyId);
        adjacency.get(a.id)!.push({ id: b.id, viaRegion: null, cost });
        adjacency.get(b.id)!.push({ id: a.id, viaRegion: null, cost });
      }
    }
  }

  // Plain Dijkstra — there's no admissible heuristic once elevation enters
  // the cost (plan-distance and floor-height aren't the same units).
  const cameFrom = new Map<string, { prev: string; viaRegion: string | null }>();
  const gScore = new Map<string, number>([["__start", 0]]);
  const open = new MinHeap<{ id: string; g: number }>((a, b) => a.g < b.g);
  open.push({ id: "__start", g: 0 });
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
    for (const n of adjacency.get(current.id) ?? []) {
      const tentative = gCur + n.cost;
      if (tentative >= (gScore.get(n.id) ?? Infinity)) continue;
      cameFrom.set(n.id, { prev: current.id, viaRegion: n.viaRegion });
      gScore.set(n.id, tentative);
      open.push({ id: n.id, g: tentative });
    }
  }

  if (!foundEnd) {
    return { found: false, note: "No multi-storey path found", segments: [] };
  }

  const chain: { id: string; viaRegion: string | null }[] = [];
  let cur = "__end";
  while (cur !== "__start") {
    const step = cameFrom.get(cur);
    if (!step) {
      return { found: false, note: "Path reconstruction failed", segments: [] };
    }
    chain.push({ id: cur, viaRegion: step.viaRegion });
    cur = step.prev;
  }
  chain.reverse();

  const segments: { storeyId: string; points: Point2D[] }[] = [];
  let currentStoreyId = start.storeyId;
  let currentPoints: Point2D[] = [];
  let fromPt = start.point;
  for (const step of chain) {
    const toNode = nodes.get(step.id)!;
    if (step.viaRegion == null) {
      // Vertical hop through a stair/lift: close out this storey's segment
      // and start a fresh one on the far side rather than local-walking
      // (there's no walkable path between two different floor plans).
      if (currentPoints.length) {
        segments.push({ storeyId: currentStoreyId, points: currentPoints });
      }
      currentStoreyId = toNode.storeyId;
      currentPoints = [toNode.point];
      fromPt = toNode.point;
      continue;
    }
    const region = regionByIdPerStorey.get(toNode.storeyId)?.get(step.viaRegion);
    if (!region) {
      return { found: false, note: "Missing region on path", segments: [] };
    }
    const seg = localWalk(fromPt, toNode.point, region, footprints);
    if (!seg.length) {
      return { found: false, note: `No walk in ${region.name}`, segments: [] };
    }
    if (currentPoints.length) {
      currentPoints.push(...seg.slice(1));
    } else {
      currentPoints.push(...seg);
    }
    fromPt = toNode.point;
  }
  if (currentPoints.length) {
    segments.push({ storeyId: currentStoreyId, points: currentPoints });
  }

  const storeyCount = new Set(segments.map((s) => s.storeyId)).size;
  return {
    found: segments.length > 0,
    note: `${chain.length} hops across ${storeyCount} storeys`,
    segments,
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
