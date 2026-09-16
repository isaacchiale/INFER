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

/** Shoelace formula — plan area in m², independent of winding direction. */
function polygonArea(poly: Point2D[]): number {
  if (poly.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Region floor area minus any holes (columns, shafts) — negative/degenerate holes just don't subtract. */
function regionArea(region: NavmeshRegion): number {
  const holesArea = (region.holes ?? []).reduce((sum, hole) => sum + polygonArea(hole), 0);
  return Math.max(polygonArea(region.polygon) - holesArea, 0);
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
  /**
   * Optional externally-owned region-geometry cache — lets a caller that
   * also needs `regionGeometry` results for its own work (computeEvacuationLoad,
   * which seeds a Dijkstra from each region's own geometry) share this
   * function's cache instead of each recomputing it. `findNavmeshPath` and
   * `findNearestExitPath` don't pass one, so their behaviour (a fresh,
   * call-scoped cache) is unchanged.
   */
  sharedGeometryCache?: Map<string, { obstacles: Point2D[][]; voids: Point2D[][] }>,
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
  const geomByRegion =
    sharedGeometryCache ?? new Map<string, { obstacles: Point2D[][]; voids: Point2D[][] }>();
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
): { points: Point2D[]; hops: number; portalIds: string[] } | null {
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
  // Every hop's node id is a real portal graph node — i.e. a NavmeshPortal.id
  // (see buildPortalGraph: `nodes.set(p.id, {...})` for each `p` of
  // `mesh.portals`) — with one exception: findNavmeshPath (click-to-click)
  // calls this with a synthetic "__end" id as `endId`, which then shows up
  // as the last entry here too (the walk-back loop only ever excludes
  // `startId`, never `endId`). findNearestExitPath below never has this
  // problem — its `endId` is always a real exit portal node — which is the
  // only caller that currently reads `portalIds`.
  return { points, hops: chain.length, portalIds: chain.map((s) => s.id) };
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
): {
  found: boolean;
  points: Point2D[];
  note: string;
  exitPortalId?: string;
  /** Every portal (door/space/exit) the route crosses, in order — used to tally evacuation load per portal (see computeEvacuationLoad). Empty when not found or already at an exit. */
  portalIds: string[];
} {
  const startRegion = regionAtPoint(mesh, start);
  if (!startRegion) {
    return { found: false, points: [], note: "Pick a point inside a walkable region", portalIds: [] };
  }

  const hasExit = mesh.portals.some((p) => p.kind === "exit" && !opts.blockedPortalIds?.has(p.id));
  if (!hasExit) {
    return { found: false, points: [], note: "No exit portal on this storey", portalIds: [] };
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
    return { found: false, points: [], note: "No reachable exit", portalIds: [] };
  }

  if (exitId === "__start") {
    return {
      found: true,
      points: [start],
      note: "Already at an exit",
      exitPortalId: exitId,
      portalIds: [],
    };
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
    return { found: false, points: [], note: "Path reconstruction failed", portalIds: [] };
  }

  return {
    found: stitched.points.length >= 2,
    points: stitched.points,
    note: `${stitched.hops} hops to exit`,
    exitPortalId: exitId,
    portalIds: stitched.portalIds,
  };
}

export type EvacuationLoadResult = {
  /** Portal id -> estimated occupant load routed through it (sum of regionOccupantWeight over every region whose nearest-exit route crosses it — see computeEvacuationLoad's doc comment). Not necessarily a whole number; round for display. Keys include both real StoreyNavmesh.portals ids and stairNodes ids below. */
  portalLoad: Map<string, number>;
  /** Region (space) ids with no reachable exit at all — a real finding worth surfacing on its own, not just a routing failure to ignore. */
  unreachableSpaceIds: string[];
  /** Region (space) ids skipped because no interior start point could be found for their footprint polygon (a geometry-extraction issue, not a routing one). */
  skippedSpaceIds: string[];
  /**
   * Stair/lift evacuation nodes considered on this storey — not part of
   * StoreyNavmesh.portals (they don't come from the footprint/graph portal
   * data at all, see computeEvacuationLoad's doc comment on why stairs are
   * treated as valid exits here), so a caller rendering `portalLoad` needs
   * their positions from here to draw them, distinctly from real doors.
   */
  stairNodes: { id: string; point: Point2D }[];
};

/**
 * Rough occupant-count proxy for a room, used to weight its contribution to
 * the evacuation load instead of treating a broom closet and a hall the
 * same because they're both "one room." Not a formal egress occupant-load
 * calculation — those vary by room *use* (office/assembly/residential),
 * which this app doesn't classify — just floor area over a generic
 * assumed density, honest about being an estimate rather than a code
 * calculation. Minimum of 1 so a small or zero-measured room still counts
 * as occupiable rather than contributing nothing.
 */
const ASSUMED_AREA_PER_OCCUPANT_M2 = 10;
function regionOccupantWeight(region: NavmeshRegion): number {
  return Math.max(regionArea(region) / ASSUMED_AREA_PER_OCCUPANT_M2, 1);
}

/** A point inside `region`'s polygon (respecting holes) to route from — region centroids land outside the polygon for concave/L-shaped rooms, so this falls back to a point nudged in from the first vertex, and gives up (null) only for pathological shapes. */
function interiorPointForRegion(region: NavmeshRegion): Point2D | null {
  const centroid = polygonCentroid(region.polygon);
  if (pointInSpace(centroid.x, centroid.y, region.polygon, region.holes)) return centroid;
  const v0 = region.polygon[0];
  if (!v0) return null;
  const nudged = { x: v0.x + 0.05 * (centroid.x - v0.x), y: v0.y + 0.05 * (centroid.y - v0.y) };
  if (pointInSpace(nudged.x, nudged.y, region.polygon, region.holes)) return nudged;
  return null;
}

/**
 * Runs a nearest-exit search from every region on the storey and tallies how
 * many of those routes cross each portal — the data behind the
 * evacuation-bottleneck heat map: a door or opening with a high count is one
 * a lot of the building's occupants would funnel through during an
 * evacuation, exactly the kind of pinch point egress planning cares about
 * (undersized doors, single-exit corridors serving many rooms).
 *
 * Each region's contribution is weighted by {@link regionOccupantWeight} (a
 * floor-area proxy, not real occupancy data this app doesn't have) rather
 * than counting every room the same regardless of size — a 40 m² hall and a
 * 4 m² store room shouldn't weigh the same on a door both happen to route
 * through.
 *
 * Does NOT simply call {@link findNearestExitPath} once per region — that
 * calls `buildPortalGraph` fresh every time, and `buildPortalGraph`'s
 * per-region geometry (`regionGeometry`, memoized only *within* one call)
 * scans every wall/furniture/opening in the *entire model* the first time
 * each region is touched. Rebuilding the graph from scratch per room turns
 * an O(regions) job into O(regions × walls) — cheap for the tiny test
 * fixtures this was developed against, but enough real-building geometry to
 * hang the tab for many seconds (reported as an app "hang/crash" after
 * clicking the toggle). The graph is genuinely identical across every
 * region's search (nothing about it depends on which room started the
 * route), so it's built exactly once here and reused; only each region's
 * own cheap "walk from here to my bordering doors" seed differs per room.
 *
 * Two further things that O(regions) call still can't avoid on its own —
 * `regionGeometry` still runs once per region, it just no longer repeats —
 * are trimmed too, since they measurably compound on a real multi-storey
 * building rather than the single-storey fixtures this was tuned against:
 *
 * - `footprints.walls`/`furniture`/`openings` are filtered down to this
 *   storey (plus the no-storey-recorded items already treated as
 *   "every storey" everywhere else in the app) once, up front — every
 *   region's `wallsOverlappingSpace` etc. would otherwise iterate every
 *   wall in the *whole building*, storeys it can't possibly reach
 *   included, on every one of the O(regions) calls.
 * - `buildPortalGraph`'s own region-geometry cache is shared with this
 *   function's per-region seeding step instead of each keeping a separate
 *   one — the two were computing the identical `regionGeometry` result for
 *   the same region twice.
 *
 * Also, unlike a bare {@link findNearestExitPath} call, this treats any
 * stair/lift landing on this storey (from `connectivityGraph`, when given)
 * as a valid evacuation target too, not just a real exterior "exit" door.
 * Without that, `mesh.portals` has no `kind: "exit"` entries at all on any
 * storey with no ground-level exterior door — i.e. every storey of a
 * typical multi-storey building except the one the exits are actually on —
 * and this would report *every single room* as having no reachable exit.
 * That's not a real finding, it's this function not knowing stairs exist.
 * Deliberately simple here too: any stair/lift connector on the storey
 * counts, with no directionality check (up vs. down) and no verification
 * that it actually leads to a real exit further down the building — it's
 * "reached evacuation infrastructure," not "confirmed a full path outside."
 */
export function computeEvacuationLoad(
  mesh: StoreyNavmesh,
  footprints?: FootprintsDocument | null,
  opts: { blockedPortalIds?: ReadonlySet<string> } = {},
  connectivityGraph?: ConnectivityGraph | null,
): EvacuationLoadResult {
  const portalLoad = new Map<string, number>();
  const unreachableSpaceIds: string[] = [];
  const skippedSpaceIds: string[] = [];

  const stairNodes: PortalGraphNode[] = [];
  if (footprints && connectivityGraph) {
    const connectorsByLink = buildVerticalConnectors(connectivityGraph, footprints);
    for (const [linkId, connectors] of connectorsByLink) {
      const onThis = connectors.find((c) => c.storeyId === mesh.storeyId);
      if (!onThis) continue;
      const nodeId = `vertical-evac:${linkId}:${onThis.spaceId}`;
      if (opts.blockedPortalIds?.has(nodeId)) continue;
      stairNodes.push({ id: nodeId, point: onThis.point, regions: [onThis.spaceId], isExit: true });
    }
  }

  const hasExit =
    mesh.portals.some((p) => p.kind === "exit" && !opts.blockedPortalIds?.has(p.id)) ||
    stairNodes.length > 0;
  if (!hasExit) {
    for (const region of mesh.regions) unreachableSpaceIds.push(region.spaceId);
    return { portalLoad, unreachableSpaceIds, skippedSpaceIds, stairNodes: [] };
  }

  // Same "no storey recorded => treated as every storey" rule wallsAdded/
  // furnitureAdded elsewhere in this file (and footprintOverlapsSpace in
  // geometric-path.ts) already apply — this doesn't change which
  // walls/furniture/openings end up counted, only how many get iterated to
  // find out, since footprintOverlapsSpace already rejects a genuine
  // cross-storey mismatch itself.
  const onThisStorey = <T extends { storey_global_id: string | null }>(items: T[] | undefined): T[] =>
    (items ?? []).filter((item) => item.storey_global_id == null || item.storey_global_id === mesh.storeyId);
  const scopedFootprints: FootprintsDocument | null | undefined = footprints
    ? {
        ...footprints,
        walls: onThisStorey(footprints.walls),
        furniture: onThisStorey(footprints.furniture),
        openings: onThisStorey(footprints.openings),
      }
    : footprints;

  const regionById = new Map(mesh.regions.map((r) => [r.spaceId, r]));
  const geometryCache = new Map<string, { obstacles: Point2D[][]; voids: Point2D[][] }>();
  const graph = buildPortalGraph(
    mesh,
    regionById,
    stairNodes,
    scopedFootprints,
    opts.blockedPortalIds,
    geometryCache,
  );

  const nodesByRegion = new Map<string, PortalGraphNode[]>();
  for (const node of graph.nodes.values()) {
    for (const regionId of node.regions) {
      const list = nodesByRegion.get(regionId) ?? [];
      list.push(node);
      nodesByRegion.set(regionId, list);
    }
  }

  for (const region of mesh.regions) {
    const start = interiorPointForRegion(region);
    if (!start) {
      skippedSpaceIds.push(region.spaceId);
      continue;
    }

    const borderNodes = nodesByRegion.get(region.spaceId) ?? [];
    if (!borderNodes.length) {
      unreachableSpaceIds.push(region.spaceId);
      continue;
    }

    // Seed Dijkstra directly from this region's own bordering portals
    // (costed the same way buildPortalGraph costs its own edges) instead of
    // inserting a synthetic start node into the shared graph — the whole
    // point is to leave `graph` untouched so it stays reusable as-is for
    // every other region. geometryCache was already populated for this
    // region by buildPortalGraph above whenever the region has >1 bordering
    // portal (the common case); only borderNodes.length === 1 regions (a
    // dead-end room with exactly one door) reach buildPortalGraph without
    // it, since that loop only costs edges *between* portals.
    let geom = geometryCache.get(region.spaceId);
    if (!geom) {
      geom = regionGeometry(region, scopedFootprints);
      geometryCache.set(region.spaceId, geom);
    }
    const { obstacles, voids } = geom;
    const gScore = new Map<string, number>();
    const cameFrom = new Map<string, { prev: string; viaRegion: string }>();
    const open = new MinHeap<{ id: string; g: number }>((a, b) => a.g < b.g);
    for (const node of borderNodes) {
      const g = traversalCost(start, node.point, region, obstacles, voids);
      if (g < (gScore.get(node.id) ?? Infinity)) {
        gScore.set(node.id, g);
        open.push({ id: node.id, g });
      }
    }

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
      unreachableSpaceIds.push(region.spaceId);
      continue;
    }

    // Walk back from the exit to whichever seed border node it started
    // from — cameFrom has no entry for that node (it was a Dijkstra source,
    // never relaxed via an edge), which is what stops the walk, the same
    // pattern stitchPortalPath uses with a single synthetic start id.
    const weight = regionOccupantWeight(region);
    let cur = exitId;
    for (;;) {
      portalLoad.set(cur, (portalLoad.get(cur) ?? 0) + weight);
      const step = cameFrom.get(cur);
      if (!step) break;
      cur = step.prev;
    }
  }

  return {
    portalLoad,
    unreachableSpaceIds,
    skippedSpaceIds,
    stairNodes: stairNodes.map((n) => ({ id: n.id, point: n.point })),
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

/**
 * Precompute once per caller (not per pair) — both call sites below use this
 * inside an all-pairs connector loop, so an O(storeys) scan per call would
 * make the whole thing O(pairs × storeys) instead of just O(pairs) on a
 * building with many storeys.
 */
function storeyElevationLookup(
  footprints: FootprintsDocument | null | undefined,
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const s of footprints?.storeys ?? []) {
    if (Number.isFinite(s.elevation)) map.set(s.global_id, s.elevation as number);
  }
  return map;
}

function verticalHopCost(
  storeyElevationByGlobalId: ReadonlyMap<string, number>,
  storeyA: string,
  storeyB: string,
): number {
  const elevA = storeyElevationByGlobalId.get(storeyA);
  const elevB = storeyElevationByGlobalId.get(storeyB);
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
  const storeyElevationByGlobalId = storeyElevationLookup(footprints);
  // Chain each stair/lift's landings in elevation order and link only
  // *adjacent* pairs, not every pair — O(connectors) edges instead of
  // O(connectors^2). Costs come out identical for real (monotonic-elevation)
  // storeys either way: a trip between two non-adjacent landings still gets
  // the same total cost from Dijkstra summing the intermediate hops as it
  // would from one direct all-pairs edge, since |eA-eC| = |eA-eB|+|eB-eC|
  // whenever B lies between A and C in elevation. A 150-storey, 10-stair
  // synthetic building went from ~1.5s to a few ms in testing after this —
  // the all-pairs version was the dominant cost, not vertical hop lookup.
  for (const nodeIds of connectorNodeIdsByLink.values()) {
    if (nodeIds.length < 2) continue;
    const sorted = [...nodeIds].sort((idA, idB) => {
      const ea = storeyElevationByGlobalId.get(nodes.get(idA)!.storeyId) ?? 0;
      const eb = storeyElevationByGlobalId.get(nodes.get(idB)!.storeyId) ?? 0;
      return ea - eb;
    });
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = nodes.get(sorted[i]!)!;
      const b = nodes.get(sorted[i + 1]!)!;
      const cost = verticalHopCost(storeyElevationByGlobalId, a.storeyId, b.storeyId);
      adjacency.get(a.id)!.push({ id: b.id, viaRegion: null, cost });
      adjacency.get(b.id)!.push({ id: a.id, viaRegion: null, cost });
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

export type BuildingEvacuationLoadResult = {
  /** Same shape as EvacuationLoadResult.portalLoad, but spanning every storey — a ground-floor door's count includes traffic funnelled down from upper floors through connecting stairs, not just its own floor's rooms. */
  portalLoad: Map<string, number>;
  /** Region (space) ids with no reachable exit anywhere in the *building* (not just their own storey). */
  unreachableSpaceIds: string[];
  skippedSpaceIds: string[];
  /** Stair/lift nodes considered, across every storey — a caller renders them per-storey using `storeyId`. */
  stairNodes: { id: string; storeyId: string; point: Point2D }[];
};

/**
 * Building-wide version of {@link computeEvacuationLoad}: instead of
 * stopping a room's simulated route the moment it reaches a stairwell
 * (that function's scope, since it only knows about one storey), this
 * actually continues the route through the stair onto whichever storey it
 * lands on, repeating until it reaches a real exterior exit door somewhere
 * in the building. A ground-floor lobby door's count then reflects everyone
 * funnelling through it from upper floors too, not just the rooms on that
 * floor — which is the whole point of an evacuation-load analysis on a
 * real multi-storey building.
 *
 * Not implemented as "call computeEvacuationLoad once per storey and add up
 * the results" — that can't chain through a stair, by construction (each
 * call only ever sees one storey's mesh). Instead this builds one combined
 * portal graph across every storey (mirroring {@link findMultiStoreyNavmeshPath}'s
 * construction — portal nodes per storey plus all-pairs vertical-connector
 * links weighted by {@link verticalHopCost}, not a second implementation of
 * that from scratch) and runs a single *multi-source* Dijkstra seeded from
 * every real exit portal in the building at once. That single pass gives
 * the shortest distance-to-nearest-exit for every node in the whole
 * building in one go; each region then just needs one cheap lookup — which
 * of its own bordering nodes gets it to an exit fastest — rather than a
 * separate Dijkstra run per room. That's *more* efficient than the
 * per-storey version despite covering the whole building, not less: one
 * Dijkstra over everything beats one per room.
 *
 * Same honestly-scoped simplifications as the per-storey version: no
 * directionality check on stairs (up vs. down), no verification that a
 * stair actually leads anywhere better, and region weight is the same
 * floor-area proxy from {@link regionOccupantWeight}, not real occupancy.
 */
export function computeBuildingEvacuationLoad(
  meshes: StoreyNavmesh[],
  footprints: FootprintsDocument | null | undefined,
  connectivityGraph: ConnectivityGraph | null | undefined,
  opts: { blockedPortalIds?: ReadonlySet<string>; blockedConnectorIds?: ReadonlySet<string> } = {},
): BuildingEvacuationLoadResult {
  const portalLoad = new Map<string, number>();
  const unreachableSpaceIds: string[] = [];
  const skippedSpaceIds: string[] = [];

  type MultiNode = {
    id: string;
    storeyId: string;
    point: Point2D;
    regions: string[];
    isExit?: boolean;
  };
  const nodes = new Map<string, MultiNode>();
  const regionByIdPerStorey = new Map<string, Map<string, NavmeshRegion>>();
  for (const mesh of meshes) {
    regionByIdPerStorey.set(mesh.storeyId, new Map(mesh.regions.map((r) => [r.spaceId, r])));
  }

  for (const mesh of meshes) {
    for (const p of mesh.portals) {
      if (opts.blockedPortalIds?.has(p.id)) continue;
      nodes.set(p.id, {
        id: p.id,
        storeyId: mesh.storeyId,
        point: p.point,
        regions: p.spaceB ? [p.spaceA, p.spaceB] : [p.spaceA],
        isExit: p.kind === "exit",
      });
    }
  }

  const stairNodesOut: { id: string; storeyId: string; point: Point2D }[] = [];
  const connectorNodeIdsByLink = new Map<string, string[]>();
  if (footprints && connectivityGraph) {
    const connectorsByLink = buildVerticalConnectors(connectivityGraph, footprints);
    for (const [linkId, connectors] of connectorsByLink) {
      for (const c of connectors) {
        if (!regionByIdPerStorey.get(c.storeyId)?.has(c.spaceId)) continue;
        const connectorKey = `${linkId}@${c.storeyId}`;
        if (opts.blockedConnectorIds?.has(connectorKey)) continue;
        const id = `vlink-evac:${connectorKey}`;
        nodes.set(id, { id, storeyId: c.storeyId, point: c.point, regions: [c.spaceId] });
        stairNodesOut.push({ id, storeyId: c.storeyId, point: c.point });
        const list = connectorNodeIdsByLink.get(linkId) ?? [];
        list.push(id);
        connectorNodeIdsByLink.set(linkId, list);
      }
    }
  }

  // Storey-scoped footprints + a per-storey geometry cache — same
  // performance fix as computeEvacuationLoad, for the same reason: this
  // touches every region across the whole building, so an unscoped
  // regionGeometry (which scans every wall/furniture/opening in the
  // *entire model*) would compound across every storey, not just repeat
  // within one.
  const onThisStorey = <T extends { storey_global_id: string | null }>(
    items: T[] | undefined,
    storeyId: string,
  ): T[] =>
    (items ?? []).filter((item) => item.storey_global_id == null || item.storey_global_id === storeyId);
  const scopedFootprintsCache = new Map<string, FootprintsDocument | null | undefined>();
  const scopedFootprintsFor = (storeyId: string): FootprintsDocument | null | undefined => {
    let scoped = scopedFootprintsCache.get(storeyId);
    if (scoped !== undefined) return scoped;
    scoped = footprints
      ? {
          ...footprints,
          walls: onThisStorey(footprints.walls, storeyId),
          furniture: onThisStorey(footprints.furniture, storeyId),
          openings: onThisStorey(footprints.openings, storeyId),
        }
      : footprints;
    scopedFootprintsCache.set(storeyId, scoped);
    return scoped;
  };
  const geometryCacheByStorey = new Map<
    string,
    Map<string, { obstacles: Point2D[][]; voids: Point2D[][] }>
  >();
  const geometryFor = (storeyId: string, region: NavmeshRegion) => {
    let cache = geometryCacheByStorey.get(storeyId);
    if (!cache) {
      cache = new Map();
      geometryCacheByStorey.set(storeyId, cache);
    }
    let g = cache.get(region.spaceId);
    if (!g) {
      g = regionGeometry(region, scopedFootprintsFor(storeyId));
      cache.set(region.spaceId, g);
    }
    return g;
  };

  const nodesByRegion = new Map<string, MultiNode[]>();
  for (const node of nodes.values()) {
    for (const regionId of node.regions) {
      const list = nodesByRegion.get(regionId) ?? [];
      list.push(node);
      nodesByRegion.set(regionId, list);
    }
  }

  const adjacency = new Map<string, { id: string; viaRegion: string | null; cost: number }[]>();
  for (const node of nodes.values()) {
    const out: { id: string; viaRegion: string | null; cost: number }[] = [];
    const linked = new Set<string>();
    for (const regionId of node.regions) {
      // node.storeyId === other.storeyId is guaranteed: space ids are
      // globally unique, so two nodes sharing a regionId share a storey.
      const region = regionByIdPerStorey.get(node.storeyId)?.get(regionId);
      for (const other of nodesByRegion.get(regionId) ?? []) {
        if (other.id === node.id || linked.has(other.id)) continue;
        linked.add(other.id);
        let cost = dist(node.point, other.point);
        if (region) {
          const { obstacles, voids } = geometryFor(node.storeyId, region);
          cost = traversalCost(node.point, other.point, region, obstacles, voids);
        }
        out.push({ id: other.id, viaRegion: regionId, cost });
      }
    }
    adjacency.set(node.id, out);
  }
  const storeyElevationByGlobalId = storeyElevationLookup(footprints);
  // Chain each stair/lift's landings in elevation order and link only
  // *adjacent* pairs, not every pair — O(connectors) edges instead of
  // O(connectors^2). Costs come out identical for real (monotonic-elevation)
  // storeys either way: a trip between two non-adjacent landings still gets
  // the same total cost from Dijkstra summing the intermediate hops as it
  // would from one direct all-pairs edge, since |eA-eC| = |eA-eB|+|eB-eC|
  // whenever B lies between A and C in elevation. A 150-storey, 10-stair
  // synthetic building went from ~1.5s to a few ms in testing after this —
  // the all-pairs version was the dominant cost, not vertical hop lookup.
  for (const nodeIds of connectorNodeIdsByLink.values()) {
    if (nodeIds.length < 2) continue;
    const sorted = [...nodeIds].sort((idA, idB) => {
      const ea = storeyElevationByGlobalId.get(nodes.get(idA)!.storeyId) ?? 0;
      const eb = storeyElevationByGlobalId.get(nodes.get(idB)!.storeyId) ?? 0;
      return ea - eb;
    });
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = nodes.get(sorted[i]!)!;
      const b = nodes.get(sorted[i + 1]!)!;
      const cost = verticalHopCost(storeyElevationByGlobalId, a.storeyId, b.storeyId);
      adjacency.get(a.id)!.push({ id: b.id, viaRegion: null, cost });
      adjacency.get(b.id)!.push({ id: a.id, viaRegion: null, cost });
    }
  }

  // Multi-source Dijkstra seeded from every real exit in the building —
  // gives shortest distance-to-nearest-exit for every node in one pass.
  const gScore = new Map<string, number>();
  const cameFrom = new Map<string, { prev: string; viaRegion: string | null }>();
  const open = new MinHeap<{ id: string; g: number }>((a, b) => a.g < b.g);
  for (const node of nodes.values()) {
    if (node.isExit) {
      gScore.set(node.id, 0);
      open.push({ id: node.id, g: 0 });
    }
  }
  if (open.size === 0) {
    for (const mesh of meshes) {
      for (const region of mesh.regions) unreachableSpaceIds.push(region.spaceId);
    }
    return { portalLoad, unreachableSpaceIds, skippedSpaceIds, stairNodes: [] };
  }
  const closed = new Set<string>();
  while (open.size) {
    const current = open.pop()!;
    if (closed.has(current.id)) continue;
    closed.add(current.id);
    const gCur = gScore.get(current.id) ?? Infinity;
    for (const n of adjacency.get(current.id) ?? []) {
      const tentative = gCur + n.cost;
      if (tentative >= (gScore.get(n.id) ?? Infinity)) continue;
      cameFrom.set(n.id, { prev: current.id, viaRegion: n.viaRegion });
      gScore.set(n.id, tentative);
      open.push({ id: n.id, g: tentative });
    }
  }

  // Each region picks whichever of its own bordering nodes gets it to an
  // exit cheapest — the local "walk to the door" cost plus that node's
  // already-known distance to the nearest exit.
  for (const mesh of meshes) {
    for (const region of mesh.regions) {
      const start = interiorPointForRegion(region);
      if (!start) {
        skippedSpaceIds.push(region.spaceId);
        continue;
      }
      const borderNodes = nodesByRegion.get(region.spaceId) ?? [];
      if (!borderNodes.length) {
        unreachableSpaceIds.push(region.spaceId);
        continue;
      }

      const { obstacles, voids } = geometryFor(mesh.storeyId, region);
      let bestNodeId: string | null = null;
      let bestTotal = Infinity;
      for (const node of borderNodes) {
        const distToExit = gScore.get(node.id);
        if (distToExit == null) continue;
        const total = traversalCost(start, node.point, region, obstacles, voids) + distToExit;
        if (total < bestTotal) {
          bestTotal = total;
          bestNodeId = node.id;
        }
      }
      if (bestNodeId == null) {
        unreachableSpaceIds.push(region.spaceId);
        continue;
      }

      const weight = regionOccupantWeight(region);
      let cur = bestNodeId;
      for (;;) {
        portalLoad.set(cur, (portalLoad.get(cur) ?? 0) + weight);
        const step = cameFrom.get(cur);
        if (!step) break;
        cur = step.prev;
      }
    }
  }

  return { portalLoad, unreachableSpaceIds, skippedSpaceIds, stairNodes: stairNodesOut };
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
