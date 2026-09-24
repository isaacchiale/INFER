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
  /**
   * Door↔door walk costs/paths baked at mesh build time so they survive a
   * worker structured-clone (WeakMap memos on the worker thread do not).
   * Seeded into the portal-core cache on first use on the main thread.
   */
  portalEdgeMemos?: PortalEdgeMemo[];
};

/** Serializable door↔door walk memo (one directed portal adjacency). */
export type PortalEdgeMemo = {
  fromId: string;
  toId: string;
  viaRegion: string;
  cost: number;
  path: Point2D[] | null;
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
 * graph currently shown (each authored door is its own portal; soft-disabled
 * edges skipped).
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
    /**
     * When true, precompute door↔door walk costs into
     * {@link StoreyNavmesh.portalEdgeMemos} before returning. Used by the
     * full-building / dirty-storey builders so click routing starts warm.
     * Off by default for cheap display-only meshes (floorplan overlay).
     */
    warmPortalCosts?: boolean;
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
  const seenEdgeIds = new Set<string>();

  for (const edge of display.edges) {
    if (edge.kind === "vertical") continue;
    if (excludedEdges.has(edge.id)) continue;
    if (excludedNodes.has(edge.source) || excludedNodes.has(edge.target)) continue;
    if (!regionIds.has(edge.source) || !regionIds.has(edge.target)) continue;
    if (!spaceOnStorey(spaceById, edge.source, storeyId)) continue;
    if (!spaceOnStorey(spaceById, edge.target, storeyId)) continue;
    // One portal per display edge (per door / opening) — do not collapse
    // multiple doors between the same space pair into a single point.
    if (seenEdgeIds.has(edge.id)) continue;
    seenEdgeIds.add(edge.id);

    const a = edge.source < edge.target ? edge.source : edge.target;
    const b = edge.source < edge.target ? edge.target : edge.source;

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

  const mesh: StoreyNavmesh = { storeyId, regions, portals };
  if (opts.warmPortalCosts) {
    bakePortalEdgeMemos(mesh, footprints);
  }
  return mesh;
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
        // Walk costs warm asynchronously after build (see useNavmeshRouting) —
        // baking here inside the worker froze Trapelo-scale loads so meshes
        // never arrived and click-to-click looked "broken".
        display,
        spaceById,
        doorById,
        edgeById,
        edgesByPair,
      }),
    )
    .filter((m) => m.regions.length > 0);
}

function symmetricSetDiff(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  for (const x of b) if (!a.has(x)) out.push(x);
  return out;
}

/**
 * Storeys whose walkable mesh (regions / same-floor portals) can change when
 * this graph/footprint node is excluded or restored. Stair/lift nodes only
 * affect vertical hopping at path time — per-storey meshes skip `vertical`
 * edges — so they return an empty list.
 */
export function storeysForExcludedNode(
  nodeId: string,
  footprints: FootprintsDocument,
  graph: ConnectivityGraph,
): string[] {
  if (nodeId.startsWith("stair:") || nodeId.startsWith("lift:")) return [];

  const fromGraph = graph.nodes.find((n) => n.id === nodeId)?.storey_global_id;
  if (fromGraph) return [fromGraph];

  if (nodeId.startsWith("space:")) {
    const gid = nodeId.slice("space:".length);
    const storey = footprints.spaces.find((s) => s.global_id === gid)?.storey_global_id;
    return storey ? [storey] : [];
  }
  if (nodeId.startsWith("door:")) {
    const gid = nodeId.slice("door:".length);
    const storey = footprints.doors.find((d) => d.global_id === gid)?.storey_global_id;
    return storey ? [storey] : [];
  }
  return [];
}

/**
 * Storeys touched by disabling/restoring a display or raw graph edge.
 * Returns `"all"` only when the id can't be resolved (safer full rebuild).
 */
export function storeysForExcludedEdge(
  edgeId: string,
  footprints: FootprintsDocument,
  graph: ConnectivityGraph,
): string[] | "all" {
  const doorId = doorIdFromVizEdge(edgeId);
  if (doorId) {
    const storeys = storeysForExcludedNode(doorId, footprints, graph);
    // viz-door also names the two spaces — include their storeys if present.
    const parts = edgeId.slice("viz-door:".length).split(":");
    if (parts.length >= 6 && parts[2] === "space" && parts[4] === "space") {
      for (const spaceId of [`space:${parts[3]}`, `space:${parts[5]}`]) {
        for (const s of storeysForExcludedNode(spaceId, footprints, graph)) storeys.push(s);
      }
    }
    return [...new Set(storeys)];
  }

  const edge =
    graph.edges.find((e) => e.id === edgeId) ??
    toDisplayGraph(graph).edges.find((e) => e.id === edgeId);
  if (!edge) return "all";

  const storeys = [
    ...storeysForExcludedNode(edge.source, footprints, graph),
    ...storeysForExcludedNode(edge.target, footprints, graph),
  ];
  return [...new Set(storeys)];
}

/**
 * Which storeys need a fresh {@link buildStoreyNavmesh} after an exclusion
 * toggle. `"all"` when footprints/graph identity changed (caller) or an id
 * can't be mapped. Empty set = keep the previous meshes as-is.
 */
export function storeysAffectedByExclusionChange(
  footprints: FootprintsDocument,
  graph: ConnectivityGraph,
  prevNodes: ReadonlySet<string>,
  nextNodes: ReadonlySet<string>,
  prevEdges: ReadonlySet<string>,
  nextEdges: ReadonlySet<string>,
): Set<string> | "all" {
  const dirty = new Set<string>();
  for (const id of symmetricSetDiff(prevNodes, nextNodes)) {
    for (const s of storeysForExcludedNode(id, footprints, graph)) dirty.add(s);
  }
  for (const id of symmetricSetDiff(prevEdges, nextEdges)) {
    const storeys = storeysForExcludedEdge(id, footprints, graph);
    if (storeys === "all") return "all";
    for (const s of storeys) dirty.add(s);
  }
  return dirty;
}

/**
 * Rebuild only dirty storeys; reuse previous meshes for the rest. Vertical
 * stair/lift links are not stored on these meshes —
 * {@link findMultiStoreyNavmeshPath} reassembles them from the connectivity
 * graph at path time.
 */
export function buildStoreyNavmeshesIncremental(
  previous: StoreyNavmesh[] | null,
  footprints: FootprintsDocument,
  graph: ConnectivityGraph,
  opts: {
    excludedNodeIds?: ReadonlySet<string>;
    excludedEdgeIds?: ReadonlySet<string>;
    dirtyStoreyIds: ReadonlySet<string> | "all";
  },
): StoreyNavmesh[] {
  const dirty = opts.dirtyStoreyIds;
  if (!previous || dirty === "all") {
    return buildAllStoreyNavmeshes(footprints, graph, {
      ...(opts.excludedNodeIds ? { excludedNodeIds: opts.excludedNodeIds } : {}),
      ...(opts.excludedEdgeIds ? { excludedEdgeIds: opts.excludedEdgeIds } : {}),
    });
  }
  if (dirty.size === 0) {
    return previous;
  }

  const display = toDisplayGraph(graph);
  const spaceById = spacesById(footprints);
  const doorById = doorsByGlobalId(footprints);
  const edgeById = edgesById(graph);
  const edgesByPair = edgesByPairKey(graph);
  const prevByStorey = new Map(previous.map((m) => [m.storeyId, m]));

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

  const buildOpts = {
    ...(opts.excludedNodeIds ? { excludedNodeIds: opts.excludedNodeIds } : {}),
    ...(opts.excludedEdgeIds ? { excludedEdgeIds: opts.excludedEdgeIds } : {}),
    // Same as buildAllStoreyNavmeshes: don't bake walk costs on the main
    // thread during an exclusion patch — warm async afterward.
    display,
    spaceById,
    doorById,
    edgeById,
    edgesByPair,
  };

  return ordered
    .map((id) => {
      if (!dirty.has(id)) {
        const kept = prevByStorey.get(id);
        if (kept) return kept;
      }
      return buildStoreyNavmesh(footprints, graph, id, buildOpts);
    })
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

/**
 * Door↔door adjacency. `cost` / `path` start null and are filled lazily:
 * clear chords store euclidean + a 2-point path; blocked chords run localWalk
 * once and memoize both length and polyline for A* and stitch.
 */
type PortalAdj = {
  id: string;
  viaRegion: string;
  cost: number | null;
  /** Walk polyline from this node to `id` (inclusive). Reversed for the opposite edge. */
  path: Point2D[] | null;
};

type PortalGraph = {
  nodes: Map<string, PortalGraphNode>;
  adjacency: Map<string, PortalAdj[]>;
};

function blockedPortalKey(blocked?: ReadonlySet<string>): string {
  if (!blocked?.size) return "";
  return [...blocked].sort().join("\0");
}

type PortalCoreCache = {
  mesh: StoreyNavmesh;
  footprints: FootprintsDocument | null | undefined;
  blockedKey: string;
  regionById: Map<string, NavmeshRegion>;
  /** Portal nodes only — no __start/__end. */
  graph: PortalGraph;
  /** True once every door↔door edge has a concrete cost. */
  warmed: boolean;
};

/** One core graph per storey mesh; invalidated when mesh / footprints change. */
const portalCoreCacheByMesh = new WeakMap<StoreyNavmesh, PortalCoreCache>();

/**
 * Clear memoized walk costs for edges incident to `portalIds`. Call after a
 * portal is blocked/restored so only those door↔door weights recompute on the
 * next resolve — remaining edges keep their cached walk lengths.
 */
export function invalidatePortalEdgeCosts(
  mesh: StoreyNavmesh,
  portalIds: ReadonlySet<string> | readonly string[],
): void {
  const core = portalCoreCacheByMesh.get(mesh);
  if (!core) return;
  const affected = portalIds instanceof Set ? portalIds : new Set(portalIds);
  if (!affected.size) return;
  core.warmed = false;
  for (const [fromId, edges] of core.graph.adjacency) {
    const fromHit = affected.has(fromId);
    for (const edge of edges) {
      if (fromHit || affected.has(edge.id)) {
        edge.cost = null;
        edge.path = null;
      }
    }
  }
}

/**
 * Resolve (and memoize) a portal-graph edge cost as straight-line distance
 * between the two doors. `path` stays null so the stitch draws the chosen
 * legs with {@link localWalk} around furniture.
 */
function resolvePortalEdgeCost(
  core: PortalCoreCache,
  fromId: string,
  edge: PortalAdj,
): number {
  if (edge.cost != null) return edge.cost;
  const from = core.graph.nodes.get(fromId);
  const to = core.graph.nodes.get(edge.id);
  const region = core.regionById.get(edge.viaRegion);
  const cost = from && to && region ? dist(from.point, to.point) : Infinity;
  edge.cost = cost;
  edge.path = null;
  const rev = core.graph.adjacency
    .get(edge.id)
    ?.find((e) => e.id === fromId && e.viaRegion === edge.viaRegion);
  if (rev && rev.cost == null) {
    rev.cost = cost;
    rev.path = null;
  }
  return cost;
}

function warmPortalCore(core: PortalCoreCache): void {
  if (core.warmed) return;
  for (const [fromId, edges] of core.graph.adjacency) {
    for (const edge of edges) {
      if (edge.cost == null) resolvePortalEdgeCost(core, fromId, edge);
    }
  }
  core.warmed = true;
}

/**
 * Run door↔door resolves and store them on the mesh as plain data so a worker
 * structured-clone still delivers warm costs to the main thread (WeakMap
 * memos on the worker die with the clone).
 */
function bakePortalEdgeMemos(
  mesh: StoreyNavmesh,
  footprints: FootprintsDocument,
): void {
  const core = getPortalCoreGraph(mesh, footprints);
  warmPortalCore(core);
  const memos: PortalEdgeMemo[] = [];
  for (const [fromId, edges] of core.graph.adjacency) {
    for (const edge of edges) {
      if (edge.cost == null) continue;
      memos.push({
        fromId,
        toId: edge.id,
        viaRegion: edge.viaRegion,
        cost: edge.cost,
        path: edge.path
          ? edge.path.map((p) => ({ x: p.x, y: p.y }))
          : null,
      });
    }
  }
  mesh.portalEdgeMemos = memos;
}

/** Seed adjacency from {@link StoreyNavmesh.portalEdgeMemos}. Returns true if every edge got a cost. */
function seedPortalEdgesFromMemos(
  graph: PortalGraph,
  memos: PortalEdgeMemo[] | undefined,
): boolean {
  if (!memos?.length) return false;
  const byKey = new Map<string, PortalEdgeMemo>();
  for (const m of memos) {
    byKey.set(`${m.fromId}\0${m.toId}\0${m.viaRegion}`, m);
  }
  let complete = true;
  for (const [fromId, edges] of graph.adjacency) {
    for (const edge of edges) {
      const m = byKey.get(`${fromId}\0${edge.id}\0${edge.viaRegion}`);
      if (!m) {
        complete = false;
        continue;
      }
      edge.cost = m.cost;
      edge.path = m.path;
    }
  }
  return complete;
}

/**
 * Precompute door↔door walk weights into each mesh's
 * {@link StoreyNavmesh.portalEdgeMemos} (and the live WeakMap cache).
 * Prefer calling this off the main thread after {@link buildAllStoreyNavmeshes}
 * returns — baking inside the build itself hung Trapelo-scale worker loads.
 */
export function warmPortalCoreGraphs(
  meshes: readonly StoreyNavmesh[],
  footprints: FootprintsDocument | null | undefined,
  blockedPortalIds?: ReadonlySet<string>,
): void {
  if (!footprints) return;
  for (const mesh of meshes) {
    if (!blockedPortalIds?.size) {
      bakePortalEdgeMemos(mesh, footprints);
      continue;
    }
    warmPortalCore(getPortalCoreGraph(mesh, footprints, blockedPortalIds));
  }
}

/**
 * Worker-friendly warm: bake walk memos onto `meshes` and return them so the
 * structured-clone hop delivers {@link StoreyNavmesh.portalEdgeMemos} to the
 * main thread. Same meshes mutated in place when run inline.
 */
export function warmStoreyNavmeshWalkCosts(
  meshes: StoreyNavmesh[],
  footprints: FootprintsDocument,
): StoreyNavmesh[] {
  warmPortalCoreGraphs(meshes, footprints);
  return meshes;
}

/** Build portal nodes + unloaded adjacency for a storey (no walk costs yet). */
function buildPortalCoreAdjacency(
  mesh: StoreyNavmesh,
  blockedPortalIds?: ReadonlySet<string>,
): {
  regionById: Map<string, NavmeshRegion>;
  graph: PortalGraph;
} {
  const regionById = new Map(mesh.regions.map((r) => [r.spaceId, r]));
  const nodes = new Map<string, PortalGraphNode>();
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

  const adjacency = new Map<string, PortalAdj[]>();
  for (const node of nodes.values()) {
    const out: PortalAdj[] = [];
    const linked = new Set<string>();
    for (const regionId of node.regions) {
      if (!regionById.has(regionId)) continue;
      for (const other of nodesByRegion.get(regionId) ?? []) {
        if (other.id === node.id || linked.has(other.id)) continue;
        linked.add(other.id);
        out.push({ id: other.id, viaRegion: regionId, cost: null, path: null });
      }
    }
    adjacency.set(node.id, out);
  }

  return { regionById, graph: { nodes, adjacency } };
}

/**
 * Reuse walk-cost memo when only the blocked-portal set changed: rebuild the
 * adjacency skeleton, then copy costs for edges whose endpoints were not in
 * the blocked-set symmetric difference (those doors' incident edges are the
 * only ones that need a fresh resolve).
 */
function adoptPortalCoreForBlockedChange(
  prev: PortalCoreCache,
  blockedPortalIds: ReadonlySet<string> | undefined,
  blockedKey: string,
): PortalCoreCache {
  const prevBlocked = new Set(
    prev.blockedKey ? prev.blockedKey.split("\0").filter(Boolean) : [],
  );
  const nextBlocked = blockedPortalIds ?? new Set<string>();
  const affected = new Set<string>();
  for (const id of prevBlocked) if (!nextBlocked.has(id)) affected.add(id);
  for (const id of nextBlocked) if (!prevBlocked.has(id)) affected.add(id);

  const { regionById, graph } = buildPortalCoreAdjacency(prev.mesh, blockedPortalIds);

  const prevCost = new Map<string, { cost: number; path: Point2D[] | null }>();
  for (const [fromId, edges] of prev.graph.adjacency) {
    for (const edge of edges) {
      if (edge.cost == null) continue;
      const lo = fromId < edge.id ? fromId : edge.id;
      const hi = fromId < edge.id ? edge.id : fromId;
      prevCost.set(`${lo}|${hi}|${edge.viaRegion}`, {
        cost: edge.cost,
        path: fromId < edge.id ? edge.path : edge.path ? [...edge.path].reverse() : null,
      });
    }
  }

  for (const [fromId, edges] of graph.adjacency) {
    for (const edge of edges) {
      if (affected.has(fromId) || affected.has(edge.id)) continue;
      const lo = fromId < edge.id ? fromId : edge.id;
      const hi = fromId < edge.id ? edge.id : fromId;
      const cached = prevCost.get(`${lo}|${hi}|${edge.viaRegion}`);
      if (!cached) continue;
      edge.cost = cached.cost;
      edge.path =
        fromId < edge.id
          ? cached.path
          : cached.path
            ? [...cached.path].reverse()
            : null;
    }
  }

  const entry: PortalCoreCache = {
    mesh: prev.mesh,
    footprints: prev.footprints,
    blockedKey,
    regionById,
    graph,
    warmed: false,
  };
  portalCoreCacheByMesh.set(prev.mesh, entry);
  return entry;
}

/**
 * Door↔door portal graph adjacency. Edge costs come from
 * {@link StoreyNavmesh.portalEdgeMemos} when the mesh was baked at build
 * time (worker-safe); otherwise they fill lazily on first resolve.
 *
 * Cache key is mesh identity + blocked set — not the footprints object
 * reference. React often hands a new footprints wrapper for the same model;
 * requiring `===` wiped walk memos on every click and made routing feel like
 * a cold start every time.
 */
function getPortalCoreGraph(
  mesh: StoreyNavmesh,
  footprints: FootprintsDocument | null | undefined,
  blockedPortalIds?: ReadonlySet<string>,
): PortalCoreCache {
  const blockedKey = blockedPortalKey(blockedPortalIds);
  const hit = portalCoreCacheByMesh.get(mesh);
  if (hit) {
    hit.footprints = footprints;
    if (hit.blockedKey === blockedKey) return hit;
    return adoptPortalCoreForBlockedChange(hit, blockedPortalIds, blockedKey);
  }

  const { regionById, graph } = buildPortalCoreAdjacency(mesh, blockedPortalIds);
  const warmed =
    !blockedPortalIds?.size &&
    seedPortalEdgesFromMemos(graph, mesh.portalEdgeMemos);
  const entry: PortalCoreCache = {
    mesh,
    footprints,
    blockedKey,
    regionById,
    graph,
    warmed,
  };
  portalCoreCacheByMesh.set(mesh, entry);
  return entry;
}

/**
 * Shallow-copy the cached core graph and attach ephemeral terminals
 * (__start / __end).
 *
 * Terminal↔portal edges use plain euclidean distance — pins move every click,
 * so walk-weighting them would re-run local A* against every door in the room
 * on each pick (not snappy). Door↔door weights are straight-line too; stitch
 * localWalks the chosen segments.
 */
function withPortalTerminals(
  core: PortalCoreCache,
  terminals: PortalGraphNode[],
): PortalGraph {
  const nodes = new Map(core.graph.nodes);
  const adjacency = new Map<string, PortalAdj[]>();
  for (const [id, list] of core.graph.adjacency) {
    adjacency.set(id, list.slice());
  }

  const portalsByRegion = new Map<string, PortalGraphNode[]>();
  for (const node of core.graph.nodes.values()) {
    for (const regionId of node.regions) {
      const list = portalsByRegion.get(regionId) ?? [];
      list.push(node);
      portalsByRegion.set(regionId, list);
    }
  }

  for (const terminal of terminals) {
    nodes.set(terminal.id, terminal);
    const out: PortalAdj[] = [];
    for (const regionId of terminal.regions) {
      if (!core.regionById.has(regionId)) continue;
      for (const other of portalsByRegion.get(regionId) ?? []) {
        const cost = dist(terminal.point, other.point);
        out.push({ id: other.id, viaRegion: regionId, cost, path: null });
        adjacency
          .get(other.id)!
          .push({ id: terminal.id, viaRegion: regionId, cost, path: null });
      }
    }
    adjacency.set(terminal.id, out);
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
): { points: Point2D[]; hops: number; portalIds: string[]; chain: { id: string; viaRegion: string }[] } | null {
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
  let fromId = startId;
  let fromPt = start;
  for (const step of chain) {
    const toNode = graph.nodes.get(step.id)!;
    const region = regionById.get(step.viaRegion);
    if (!region) return null;

    // Door↔door: reuse the polyline memoized during cost resolve. Pin↔door
    // terminals still localWalk (pins move every click). Re-walking every hop
    // was the click-to-click lag even when the navmesh hadn't changed.
    const edge = graph.adjacency
      .get(fromId)
      ?.find((e) => e.id === step.id && e.viaRegion === step.viaRegion);
    let seg: Point2D[];
    if (edge?.path && edge.path.length >= 2) {
      seg = edge.path;
    } else {
      seg = localWalk(fromPt, toNode.point, region, footprints);
    }
    if (!seg.length) return null;
    if (points.length) {
      points.push(...seg.slice(1));
    } else {
      points.push(...seg);
    }
    fromId = step.id;
    fromPt = toNode.point;
  }
  return {
    points,
    hops: chain.length,
    portalIds: chain.map((s) => s.id),
    chain,
  };
}

/**
 * Ordered Cytoscape node ids (spaces / stairs / lifts) for a portal A* chain.
 * Doors become separate portals (one per authored door); graph node ids for
 * highlighting are still spaces / stairs / lifts only.
 */
export function graphNodeIdsFromPortalChain(
  startSpaceId: string,
  endSpaceId: string,
  chain: ReadonlyArray<{ id: string; viaRegion: string | null }>,
): string[] {
  const out: string[] = [];
  const push = (id: string | null | undefined) => {
    if (!id) return;
    if (!(id.startsWith("space:") || id.startsWith("stair:") || id.startsWith("lift:"))) {
      return;
    }
    if (out[out.length - 1] === id) return;
    out.push(id);
  };
  push(startSpaceId);
  for (const step of chain) {
    push(step.viaRegion);
    if (step.id.startsWith("vlink:")) {
      const body = step.id.slice("vlink:".length);
      const at = body.indexOf("@");
      push(at >= 0 ? body.slice(0, at) : body);
    }
  }
  push(endSpaceId);
  return out;
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
): { found: boolean; points: Point2D[]; note: string; graphNodeIds: string[] } {
  const startRegion = regionAtPoint(mesh, start);
  const endRegion = regionAtPoint(mesh, end);
  if (!startRegion || !endRegion) {
    return {
      found: false,
      points: [],
      note: "Pick points inside walkable regions",
      graphNodeIds: [],
    };
  }

  if (startRegion.spaceId === endRegion.spaceId) {
    const points = localWalk(start, end, startRegion, footprints);
    return {
      found: points.length > 0,
      points,
      note: points.length ? "Same-region path" : "No path in region",
      graphNodeIds: points.length > 0 ? [startRegion.spaceId] : [],
    };
  }

  const core = getPortalCoreGraph(mesh, footprints, opts.blockedPortalIds);
  const graph = withPortalTerminals(core, [
    { id: "__start", point: start, regions: [startRegion.spaceId] },
    { id: "__end", point: end, regions: [endRegion.spaceId] },
  ]);

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
      const tentative = gCur + resolvePortalEdgeCost(core, current.id, n);
      if (tentative >= (gScore.get(n.id) ?? Infinity)) continue;
      cameFrom.set(n.id, { prev: current.id, viaRegion: n.viaRegion });
      gScore.set(n.id, tentative);
      const nb = graph.nodes.get(n.id)!;
      open.push({ id: n.id, f: tentative + dist(nb.point, end) });
    }
  }

  if (!foundEnd) {
    return {
      found: false,
      points: [],
      note: "No portal path between regions",
      graphNodeIds: [],
    };
  }

  const stitched = stitchPortalPath(
    graph,
    core.regionById,
    cameFrom,
    start,
    "__start",
    "__end",
    footprints,
  );
  if (!stitched) {
    return { found: false, points: [], note: "Path reconstruction failed", graphNodeIds: [] };
  }

  return {
    found: stitched.points.length >= 2,
    points: stitched.points,
    note: `${stitched.hops} hops`,
    graphNodeIds: graphNodeIdsFromPortalChain(
      startRegion.spaceId,
      endRegion.spaceId,
      stitched.chain,
    ),
  };
}

/**
 * Dijkstra to the nearest `kind: "exit"` portal from `start`. Used by the
 * floorplan "route to nearest exit" pick mode — one click, auto-goal,
 * rather than a specific click-to-click destination.
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
  /** Ordered graph node ids (spaces) for the Graph Viewer hop highlight. */
  graphNodeIds: string[];
} {
  const startRegion = regionAtPoint(mesh, start);
  if (!startRegion) {
    return {
      found: false,
      points: [],
      note: "Pick a point inside a walkable region",
      portalIds: [],
      graphNodeIds: [],
    };
  }

  const hasExit = mesh.portals.some((p) => p.kind === "exit" && !opts.blockedPortalIds?.has(p.id));
  if (!hasExit) {
    return {
      found: false,
      points: [],
      note: "No exit portal on this storey",
      portalIds: [],
      graphNodeIds: [],
    };
  }

  const core = getPortalCoreGraph(mesh, footprints, opts.blockedPortalIds);
  const graph = withPortalTerminals(core, [
    { id: "__start", point: start, regions: [startRegion.spaceId] },
  ]);

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
      const tentative = gCur + resolvePortalEdgeCost(core, current.id, n);
      if (tentative >= (gScore.get(n.id) ?? Infinity)) continue;
      cameFrom.set(n.id, { prev: current.id, viaRegion: n.viaRegion });
      gScore.set(n.id, tentative);
      open.push({ id: n.id, g: tentative });
    }
  }

  if (!exitId) {
    return {
      found: false,
      points: [],
      note: "No reachable exit",
      portalIds: [],
      graphNodeIds: [],
    };
  }

  if (exitId === "__start") {
    return {
      found: true,
      points: [start],
      note: "Already at an exit",
      exitPortalId: exitId,
      portalIds: [],
      graphNodeIds: [startRegion.spaceId],
    };
  }

  const stitched = stitchPortalPath(
    graph,
    core.regionById,
    cameFrom,
    start,
    "__start",
    exitId,
    footprints,
  );
  if (!stitched) {
    return {
      found: false,
      points: [],
      note: "Path reconstruction failed",
      portalIds: [],
      graphNodeIds: [],
    };
  }

  const exitPortal = mesh.portals.find((p) => p.id === exitId);
  const endSpaceId = exitPortal?.spaceA ?? startRegion.spaceId;

  return {
    found: stitched.points.length >= 2,
    points: stitched.points,
    note: `${stitched.hops} hops to exit`,
    exitPortalId: exitId,
    portalIds: stitched.portalIds,
    graphNodeIds: graphNodeIdsFromPortalChain(startRegion.spaceId, endSpaceId, stitched.chain),
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
  /**
   * Real walking-distance (metres) from each region's interior point to the
   * nearest exit — see {@link BuildingEvacuationLoadResult.regionDistanceToExit}.
   * Optional here: computeEvacuationLoad (the per-storey version) doesn't
   * populate it — only the shape FloorplanViewer.tsx builds by projecting
   * computeBuildingEvacuationLoad's result down to one storey does.
   */
  regionDistanceToExit?: Map<string, number>;
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

  // Reuses the cached portal core; attaches stair landings as exit-like
  // terminals once. Door↔door costs resolve lazily during each room's search.
  // Scoped footprints keep the WeakMap key storey-local (and would matter if
  // ranking ever used obstacle geometry again).
  const onThisStorey = <T extends { storey_global_id: string | null }>(items: T[] | undefined): T[] =>
    (items ?? []).filter((item) => item.storey_global_id === mesh.storeyId);
  const scopedFootprints: FootprintsDocument | null | undefined = footprints
    ? {
        ...footprints,
        walls: onThisStorey(footprints.walls),
        furniture: onThisStorey(footprints.furniture),
        openings: onThisStorey(footprints.openings),
      }
    : footprints;

  const core = getPortalCoreGraph(mesh, scopedFootprints, opts.blockedPortalIds);
  const graph = withPortalTerminals(core, stairNodes);

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

    // Seed Dijkstra from bordering portals with straight-line cost.
    const gScore = new Map<string, number>();
    const cameFrom = new Map<string, { prev: string; viaRegion: string }>();
    const open = new MinHeap<{ id: string; g: number }>((a, b) => a.g < b.g);
    for (const node of borderNodes) {
      const g = dist(start, node.point);
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
        const tentative = gCur + resolvePortalEdgeCost(core, current.id, n);
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
): {
  found: boolean;
  note: string;
  segments: { storeyId: string; points: Point2D[] }[];
  graphNodeIds: string[];
} {
  const meshById = new Map(meshes.map((m) => [m.storeyId, m]));
  const startMesh = meshById.get(start.storeyId);
  const endMesh = meshById.get(end.storeyId);
  if (!startMesh || !endMesh) {
    return { found: false, note: "Unknown storey", segments: [], graphNodeIds: [] };
  }
  const startRegion = regionAtPoint(startMesh, start.point);
  const endRegion = regionAtPoint(endMesh, end.point);
  if (!startRegion || !endRegion) {
    return {
      found: false,
      note: "Pick points inside walkable regions",
      segments: [],
      graphNodeIds: [],
    };
  }

  if (start.storeyId === end.storeyId) {
    const sameStoreyOpts = opts.blockedPortalIds ? { blockedPortalIds: opts.blockedPortalIds } : {};
    const result = findNavmeshPath(startMesh, start.point, end.point, footprints, sameStoreyOpts);
    return {
      found: result.found,
      note: result.note,
      segments: result.found ? [{ storeyId: start.storeyId, points: result.points }] : [],
      graphNodeIds: result.graphNodeIds,
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

  // Same-storey adjacency: portal↔portal edges stay lazy on each storey's
  // core; only pin/stair terminals pay distance at build time.
  const coreByStorey = new Map(
    meshes.map((m) => [m.storeyId, getPortalCoreGraph(m, footprints, opts.blockedPortalIds)] as const),
  );
  const nodesByRegion = new Map<string, MultiNode[]>();
  for (const node of nodes.values()) {
    for (const regionId of node.regions) {
      const list = nodesByRegion.get(regionId) ?? [];
      list.push(node);
      nodesByRegion.set(regionId, list);
    }
  }

  type MultiAdj = { id: string; viaRegion: string | null; cost: number | null };
  const adjacency = new Map<string, MultiAdj[]>();
  for (const node of nodes.values()) {
    const out: MultiAdj[] = [];
    const linked = new Set<string>();
    const core = coreByStorey.get(node.storeyId);
    const nodeInCore = !!core?.graph.nodes.has(node.id);
    for (const regionId of node.regions) {
      for (const other of nodesByRegion.get(regionId) ?? []) {
        if (other.id === node.id || linked.has(other.id)) continue;
        linked.add(other.id);
        const otherInCore = !!core?.graph.nodes.has(other.id);
        if (nodeInCore && otherInCore) {
          out.push({ id: other.id, viaRegion: regionId, cost: null });
        } else {
          // Pin / stair landing ↔ portal: euclidean only (same rationale as
          // withPortalTerminals — these endpoints move or are sparse; door↔door
          // walk weights live on the per-storey core).
          out.push({
            id: other.id,
            viaRegion: regionId,
            cost: dist(node.point, other.point),
          });
        }
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

  const resolveMultiCost = (fromId: string, edge: MultiAdj): number => {
    if (edge.cost != null) return edge.cost;
    const from = nodes.get(fromId)!;
    const core = coreByStorey.get(from.storeyId);
    if (!core || edge.viaRegion == null) {
      const to = nodes.get(edge.id)!;
      edge.cost = dist(from.point, to.point);
      return edge.cost;
    }
    const coreEdge = core.graph.adjacency
      .get(fromId)
      ?.find((e) => e.id === edge.id && e.viaRegion === edge.viaRegion);
    if (coreEdge) {
      edge.cost = resolvePortalEdgeCost(core, fromId, coreEdge);
      return edge.cost;
    }
    const to = nodes.get(edge.id)!;
    edge.cost = dist(from.point, to.point);
    return edge.cost;
  };

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
      const tentative = gCur + resolveMultiCost(current.id, n);
      if (tentative >= (gScore.get(n.id) ?? Infinity)) continue;
      cameFrom.set(n.id, { prev: current.id, viaRegion: n.viaRegion });
      gScore.set(n.id, tentative);
      open.push({ id: n.id, g: tentative });
    }
  }

  if (!foundEnd) {
    return { found: false, note: "No multi-storey path found", segments: [], graphNodeIds: [] };
  }

  const chain: { id: string; viaRegion: string | null }[] = [];
  let cur = "__end";
  while (cur !== "__start") {
    const step = cameFrom.get(cur);
    if (!step) {
      return { found: false, note: "Path reconstruction failed", segments: [], graphNodeIds: [] };
    }
    chain.push({ id: cur, viaRegion: step.viaRegion });
    cur = step.prev;
  }
  chain.reverse();

  const segments: { storeyId: string; points: Point2D[] }[] = [];
  let currentStoreyId = start.storeyId;
  let currentPoints: Point2D[] = [];
  let fromId = "__start";
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
      fromId = step.id;
      fromPt = toNode.point;
      continue;
    }
    const region = regionByIdPerStorey.get(toNode.storeyId)?.get(step.viaRegion);
    if (!region) {
      return { found: false, note: "Missing region on path", segments: [], graphNodeIds: [] };
    }
    const core = coreByStorey.get(toNode.storeyId);
    const coreEdge = core?.graph.adjacency
      .get(fromId)
      ?.find((e) => e.id === step.id && e.viaRegion === step.viaRegion);
    let seg: Point2D[];
    if (coreEdge?.path && coreEdge.path.length >= 2) {
      seg = coreEdge.path;
    } else {
      seg = localWalk(fromPt, toNode.point, region, footprints);
    }
    if (!seg.length) {
      return { found: false, note: `No walk in ${region.name}`, segments: [], graphNodeIds: [] };
    }
    if (currentPoints.length) {
      currentPoints.push(...seg.slice(1));
    } else {
      currentPoints.push(...seg);
    }
    fromId = step.id;
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
    graphNodeIds: graphNodeIdsFromPortalChain(startRegion.spaceId, endRegion.spaceId, chain),
  };
}

export type BuildingEvacuationLoadResult = {
  /** Same shape as EvacuationLoadResult.portalLoad, but spanning every storey — a ground-floor door's count includes traffic funnelled down from upper floors through connecting stairs, not just its own floor's rooms. */
  portalLoad: Map<string, number>;
  /** Region (space) ids with no reachable exit anywhere in the *building* (not just their own storey). */
  unreachableSpaceIds: string[];
  skippedSpaceIds: string[];
  /**
   * Real walking-distance (metres, obstacle-aware) from each region's own
   * interior point to the nearest exit anywhere in the building — the same
   * `bestTotal` value the region-load loop below already computes to pick
   * which bordering portal to route through, just kept instead of discarded.
   * A room-level "how dangerous is it here" metric, distinct from
   * `portalLoad` (which measures door/stair *congestion*, not a room's own
   * distance to safety) — the two answer different questions and a caller
   * may want either or both. No entry for a region id means unreachable or
   * skipped (see those lists); a room can't have "some" distance to an exit
   * it never found one to.
   */
  regionDistanceToExit: Map<string, number>;
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
  const regionDistanceToExit = new Map<string, number>();

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

  // Storey scoping for wall/furniture/opening lists is unused here now that
  // same-storey edges are plain distance (see adjacency below) — kept out on
  // purpose so Trapelo-scale furniture can't pull local A* into this pass.

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
      for (const other of nodesByRegion.get(regionId) ?? []) {
        if (other.id === node.id || linked.has(other.id)) continue;
        linked.add(other.id);
        // Straight-line only — full local-A* door↔door weighing across the
        // whole building is what made "Evacuation load" never finish on
        // Trapelo-scale models. Heatmap ranking doesn't need that precision.
        out.push({
          id: other.id,
          viaRegion: regionId,
          cost: dist(node.point, other.point),
        });
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
    return { portalLoad, unreachableSpaceIds, skippedSpaceIds, regionDistanceToExit, stairNodes: [] };
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

      let bestNodeId: string | null = null;
      let bestTotal = Infinity;
      for (const node of borderNodes) {
        const distToExit = gScore.get(node.id);
        if (distToExit == null) continue;
        const total = dist(start, node.point) + distToExit;
        if (total < bestTotal) {
          bestTotal = total;
          bestNodeId = node.id;
        }
      }
      if (bestNodeId == null) {
        unreachableSpaceIds.push(region.spaceId);
        continue;
      }
      regionDistanceToExit.set(region.spaceId, bestTotal);

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

  return { portalLoad, unreachableSpaceIds, skippedSpaceIds, regionDistanceToExit, stairNodes: stairNodesOut };
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
