/**
 * Level-3 geometric path: global hop list from the connectivity router,
 * local segments constrained to space polygons via door/stair portals.
 *
 * Intermediate space centroids are skipped: only the route start/end spaces
 * use centroids; between portals we go door→door / door→opening / opening→opening
 * (and stair/lift) inside the intervening space polygon via grid A* (0.1 m cells,
 * step cost inversely proportional to wall clearance, no string-pull). Clearance
 * uses the IfcSpace exterior/holes plus overlapping IfcWall footprints inside the
 * space so routes do not cut through interior walls. Graph topology routing
 * is unchanged.
 */

import type {
  DoorPortal,
  FootprintsDocument,
  OpeningPortal,
  Point2D,
  SpaceFootprint,
  StairFootprint,
  WallFootprint,
} from "@/types/footprints";
import type { ConnectivityGraph } from "@/types/graph";

export type GeometricPathSegment = {
  storey_global_id: string | null;
  points: Point2D[];
  incomplete: boolean;
  reason?: string;
};

export type GeometricPath = {
  complete: boolean;
  segments: GeometricPathSegment[];
};

function gidFromNodeId(nodeId: string): { kind: string; global_id: string } | null {
  const idx = nodeId.indexOf(":");
  if (idx <= 0) return null;
  return { kind: nodeId.slice(0, idx), global_id: nodeId.slice(idx + 1) };
}

export function pointInPolygon(x: number, y: number, polygon: Point2D[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersect =
      pi.y > y !== pj.y > y &&
      x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y + 1e-15) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Inside exterior and not inside any hole. */
export function pointInSpace(
  x: number,
  y: number,
  exterior: Point2D[],
  holes?: Point2D[][],
): boolean {
  if (!pointInPolygon(x, y, exterior)) return false;
  for (const hole of holes ?? []) {
    if (hole.length >= 3 && pointInPolygon(x, y, hole)) return false;
  }
  return true;
}

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polygonCentroid(polygon: Point2D[]): Point2D | null {
  if (!polygon.length) return null;
  let x = 0;
  let y = 0;
  for (const p of polygon) {
    x += p.x;
    y += p.y;
  }
  return { x: x / polygon.length, y: y / polygon.length };
}

function distPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { dist: number; point: Point2D } {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-18) {
    return { dist: Math.hypot(apx, apy), point: { x: ax, y: ay } };
  }
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
  const point = { x: ax + t * abx, y: ay + t * aby };
  return {
    dist: Math.hypot(px - point.x, py - point.y),
    point,
  };
}

/**
 * Closest point on the polygon boundary (ignores interior shortcut).
 */
function closestPointOnPolygonBoundary(p: Point2D, polygon: Point2D[]): Point2D {
  if (polygon.length < 3) return { ...p };
  let best = polygon[0]!;
  let bestD = Infinity;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % n]!;
    const { dist: d, point } = distPointToSegment(p.x, p.y, a.x, a.y, b.x, b.y);
    if (d < bestD) {
      bestD = d;
      best = point;
    }
  }
  return best;
}

/**
 * Closest point on the polygon: unchanged if inside, else nearest boundary
 * point. Used so a door mesh that sits in room A enters corridor B at the
 * closest point on B (typical for inferred door↔space links).
 */
function closestPointOnPolygon(p: Point2D, polygon: Point2D[]): Point2D {
  if (polygon.length < 3) return { ...p };
  if (pointInPolygon(p.x, p.y, polygon)) return { ...p };
  return closestPointOnPolygonBoundary(p, polygon);
}

function clampPointToSpace(
  p: Point2D,
  exterior: Point2D[],
  holes?: Point2D[][],
): Point2D {
  if (pointInSpace(p.x, p.y, exterior, holes)) return { ...p };
  for (const hole of holes ?? []) {
    if (hole.length >= 3 && pointInPolygon(p.x, p.y, hole)) {
      return closestPointOnPolygonBoundary(p, hole);
    }
  }
  return closestPointOnPolygonBoundary(p, exterior);
}

/** Portal XY as used inside a given space (project if door sits outside / in a hole). */
function portalOnSpace(
  portal: Point2D,
  spacePolygon: Point2D[],
  holes?: Point2D[][],
): Point2D {
  return clampPointToSpace(portal, spacePolygon, holes);
}

/** Distance to nearest edge among polygon rings. */
function distToRings(x: number, y: number, rings: Point2D[][]): number {
  let best = Infinity;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      best = Math.min(best, distPointToSegment(x, y, a.x, a.y, b.x, b.y).dist);
    }
  }
  return best;
}

/** Distance to nearest exterior or hole edge (clearance). */
function distToSpaceWall(
  x: number,
  y: number,
  exterior: Point2D[],
  holes?: Point2D[][],
): number {
  return distToRings(x, y, [
    exterior,
    ...(holes ?? []).filter((h) => h.length >= 3),
  ]);
}

/** True if point lies in any obstacle polygon (solid interior). */
function pointInObstacles(x: number, y: number, obstacles?: Point2D[][]): boolean {
  for (const obs of obstacles ?? []) {
    if (obs.length >= 3 && pointInPolygon(x, y, obs)) return true;
  }
  return false;
}

/**
 * Clearance for A*: min distance to space boundary/holes and to interior
 * wall footprints. Cells inside an obstacle are blocked (−1). Thin walls
 * that miss the cell centre still block when within ~half a cell.
 */
function cellClearance(
  x: number,
  y: number,
  exterior: Point2D[],
  holes?: Point2D[][],
  obstacles?: Point2D[][],
): number {
  if (!pointInSpace(x, y, exterior, holes)) return -1;
  if (pointInObstacles(x, y, obstacles)) return -1;
  let d = distToSpaceWall(x, y, exterior, holes);
  if (obstacles?.length) {
    const dObs = distToRings(x, y, obstacles);
    // Half-cell thicken so 0.1 m grid can't slip through sub-cell walls.
    if (dObs < LOCAL_PATH_CELL_M * 0.45) return -1;
    d = Math.min(d, dObs);
  }
  return d;
}

/**
 * IfcWall footprints that overlap a space (same storey when known).
 * Used as solid obstacles in the local A* cost map.
 */
export function wallsOverlappingSpace(
  footprints: FootprintsDocument,
  space: SpaceFootprint,
): Point2D[][] {
  const walls = footprints.walls ?? [];
  if (!walls.length || space.polygon.length < 3) return [];

  const out: Point2D[][] = [];
  for (const wall of walls) {
    if (!wallOverlapsSpace(wall, space)) continue;
    out.push(wall.polygon);
  }
  return out;
}

function wallOverlapsSpace(wall: WallFootprint, space: SpaceFootprint): boolean {
  if (wall.incomplete || wall.polygon.length < 3) return false;
  if (
    wall.storey_global_id &&
    space.storey_global_id &&
    wall.storey_global_id !== space.storey_global_id
  ) {
    return false;
  }

  for (const p of wall.polygon) {
    if (pointInSpace(p.x, p.y, space.polygon, space.holes)) return true;
  }
  const wc = polygonCentroid(wall.polygon);
  if (wc && pointInSpace(wc.x, wc.y, space.polygon, space.holes)) return true;

  for (const p of space.polygon) {
    if (pointInPolygon(p.x, p.y, wall.polygon)) return true;
  }
  for (const hole of space.holes ?? []) {
    for (const p of hole) {
      if (pointInPolygon(p.x, p.y, wall.polygon)) return true;
    }
  }

  // Thin walls can cross the room without vertices inside either ring —
  // sample edge midpoints.
  const n = wall.polygon.length;
  for (let i = 0; i < n; i++) {
    const a = wall.polygon[i]!;
    const b = wall.polygon[(i + 1) % n]!;
    const mx = 0.5 * (a.x + b.x);
    const my = 0.5 * (a.y + b.y);
    if (pointInSpace(mx, my, space.polygon, space.holes)) return true;
  }
  return false;
}

/** Local A* inside a space, including overlapping IfcWall obstacles. */
function localPathInSpace(
  start: Point2D,
  goal: Point2D,
  space: SpaceFootprint,
  footprints: FootprintsDocument,
): Point2D[] {
  return localPathInPolygon(
    start,
    goal,
    space.polygon,
    space.holes,
    wallsOverlappingSpace(footprints, space),
  );
}

/** Fixed cell size for in-polygon A* (metres). */
export const LOCAL_PATH_CELL_M = 0.1;

/** Floor so wall-adjacent cells don't send A* cost to Infinity. */
const CLEARANCE_EPS_M = 0.02;

/**
 * Step cost inversely proportional to distance from the closest wall/hole:
 *   cost = stepLen / clearance
 */
function clearanceStepCost(stepLen: number, clearM: number): number {
  return stepLen / Math.max(clearM, CLEARANCE_EPS_M);
}

/**
 * Grid A* inside a space (door↔door, door↔centroid, etc. only).
 * Step cost ∝ 1/clearance on a 0.1 m grid (no string-pull).
 * Optional holes are treated as blocked (exterior-minus-holes).
 * Optional `obstacles` (e.g. IfcWall footprints) are solid: interior cells
 * blocked, and their edges reduce clearance like space walls.
 */
export function localPathInPolygon(
  start: Point2D,
  goal: Point2D,
  polygon: Point2D[],
  holes?: Point2D[][],
  obstacles?: Point2D[][],
): Point2D[] {
  const s = clampPointToSpace(start, polygon, holes);
  const g = clampPointToSpace(goal, polygon, holes);
  if (dist(s, g) < 1e-6) return [s];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  const cell = LOCAL_PATH_CELL_M;
  const cols = Math.max(2, Math.ceil((maxX - minX) / cell) + 1);
  const rows = Math.max(2, Math.ceil((maxY - minY) / cell) + 1);

  const key = (c: number, r: number) => `${c},${r}`;
  const cellCentre = (c: number, r: number) => ({
    x: minX + c * cell,
    y: minY + r * cell,
  });

  const clearance = new Float64Array(cols * rows);
  let maxClear = CLEARANCE_EPS_M;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const p = cellCentre(c, r);
      const d = cellClearance(p.x, p.y, polygon, holes, obstacles);
      clearance[idx] = d;
      if (d > maxClear) maxClear = d;
    }
  }

  /** Nearest free cell by Euclidean distance (no clearance preference). */
  const toFreeCell = (p: Point2D) => {
    const c0 = Math.max(0, Math.min(cols - 1, Math.round((p.x - minX) / cell)));
    const r0 = Math.max(0, Math.min(rows - 1, Math.round((p.y - minY) / cell)));
    let best = { c: c0, r: r0 };
    let bestD = Infinity;
    for (let dr = -3; dr <= 3; dr++) {
      for (let dc = -3; dc <= 3; dc++) {
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        if (clearance[r * cols + c]! < 0) continue;
        const centre = cellCentre(c, r);
        const d = Math.hypot(centre.x - p.x, centre.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = { c, r };
        }
      }
    }
    if (bestD === Infinity) {
      clearance[r0 * cols + c0] = CLEARANCE_EPS_M;
      return { c: c0, r: r0 };
    }
    return best;
  };

  const startCell = toFreeCell(s);
  const goalCell = toFreeCell(g);

  type Node = { c: number; r: number; g: number; f: number };
  const open: Node[] = [];
  const pushOpen = (n: Node) => {
    open.push(n);
  };
  const popOpen = (): Node | undefined => {
    if (!open.length) return undefined;
    let bestI = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i]!.f < open[bestI]!.f) bestI = i;
    }
    return open.splice(bestI, 1)[0];
  };

  // Admissible under cost = stepLen/clear: cheapest metre is 1/maxClear.
  const hCost = (c: number, r: number) => {
    const p = cellCentre(c, r);
    return Math.hypot(p.x - g.x, p.y - g.y) / maxClear;
  };

  pushOpen({
    c: startCell.c,
    r: startCell.r,
    g: 0,
    f: hCost(startCell.c, startCell.r),
  });
  const came = new Map<string, string>();
  const gScore = new Map<string, number>([[key(startCell.c, startCell.r), 0]]);
  const closed = new Set<string>();
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  while (open.length) {
    const cur = popOpen()!;
    const ck = key(cur.c, cur.r);
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (cur.c === goalCell.c && cur.r === goalCell.r) {
      const raw: Point2D[] = [g];
      let k: string | undefined = came.get(ck);
      while (k && k !== key(startCell.c, startCell.r)) {
        const [cs, rs] = k.split(",").map(Number) as [number, number];
        raw.push(cellCentre(cs, rs));
        k = came.get(k);
      }
      raw.push(s);
      raw.reverse();
      return raw;
    }
    for (const [dc, dr] of neighbors) {
      const nc = cur.c + dc!;
      const nr = cur.r + dr!;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const nIdx = nr * cols + nc;
      const clear = clearance[nIdx]!;
      if (clear < 0 && !(nc === goalCell.c && nr === goalCell.r)) continue;
      // No diagonal corner-cuts through blocked cells (thin IfcWalls).
      if (dc !== 0 && dr !== 0) {
        if (clearance[cur.r * cols + nc]! < 0) continue;
        if (clearance[nr * cols + cur.c]! < 0) continue;
      }

      const stepLen = Math.hypot(dc!, dr!) * cell;
      const tentative =
        cur.g +
        clearanceStepCost(stepLen, clear < 0 ? CLEARANCE_EPS_M : clear);
      const nk = key(nc, nr);
      if (tentative >= (gScore.get(nk) ?? Infinity)) continue;
      came.set(nk, ck);
      gScore.set(nk, tentative);
      pushOpen({
        c: nc,
        r: nr,
        g: tentative,
        f: tentative + hCost(nc, nr),
      });
    }
  }

  return [s, g];
}

function spaceByGid(doc: FootprintsDocument, gid: string): SpaceFootprint | undefined {
  return doc.spaces.find((s) => s.global_id === gid);
}

function doorByGid(doc: FootprintsDocument, gid: string): DoorPortal | undefined {
  return doc.doors.find((d) => d.global_id === gid);
}

function stairByGid(doc: FootprintsDocument, gid: string): StairFootprint | undefined {
  return (doc.stairs ?? []).find((s) => s.global_id === gid);
}

function usableSpace(s: SpaceFootprint | undefined): s is SpaceFootprint {
  return Boolean(s && !s.incomplete && s.polygon.length >= 3);
}

function usableStair(s: StairFootprint | undefined): s is StairFootprint {
  return Boolean(s && !s.incomplete && s.polygon.length >= 3);
}

function isPortalKind(kind: string): boolean {
  return kind === "door" || kind === "stair" || kind === "lift" || kind === "opening";
}

function openingByGid(
  doc: FootprintsDocument,
  gid: string,
): OpeningPortal | undefined {
  return (doc.openings ?? []).find((o) => o.global_id === gid);
}

/** Midpoint of the closest pair of boundary points between two space polygons. */
function interfaceMidpoint(a: SpaceFootprint, b: SpaceFootprint): Point2D | null {
  if (a.polygon.length < 3 || b.polygon.length < 3) return null;
  let bestD = Infinity;
  let best: Point2D | null = null;
  for (const p of a.polygon) {
    const q = closestPointOnPolygonBoundary(p, b.polygon);
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      best = { x: 0.5 * (p.x + q.x), y: 0.5 * (p.y + q.y) };
    }
  }
  for (const p of b.polygon) {
    const q = closestPointOnPolygonBoundary(p, a.polygon);
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      best = { x: 0.5 * (p.x + q.x), y: 0.5 * (p.y + q.y) };
    }
  }
  return best;
}

/**
 * Portal for a space↔space hop: prefer graph edge clear-span / opening portal,
 * else opening GlobalId footprint, else shared-frontage midpoint.
 * (Does not use “any opening near both rooms” — that picks facade windows.)
 */
export function portalBetweenSpaces(
  footprints: FootprintsDocument,
  spaceGidA: string,
  spaceGidB: string,
  graph?: ConnectivityGraph | null,
): Point2D | null {
  const a = spaceByGid(footprints, spaceGidA);
  const b = spaceByGid(footprints, spaceGidB);
  if (!usableSpace(a) || !usableSpace(b)) return null;

  const idA = `space:${spaceGidA}`;
  const idB = `space:${spaceGidB}`;
  if (graph) {
    const edge = graph.edges.find(
      (e) =>
        e.kind === "space_space" &&
        ((e.source === idA && e.target === idB) ||
          (e.source === idB && e.target === idA)),
    );
    if (edge?.portal && Number.isFinite(edge.portal.x) && Number.isFinite(edge.portal.y)) {
      return { x: edge.portal.x, y: edge.portal.y };
    }
    if (edge?.global_id) {
      const op = openingByGid(footprints, edge.global_id);
      if (op?.point && !op.incomplete) return op.point;
    }
  }

  return interfaceMidpoint(a, b);
}

/** First intervening space between two route indices (exclusive). */
function spaceBetween(
  nodeIds: string[],
  footprints: FootprintsDocument,
  fromIdx: number,
  toIdx: number,
): SpaceFootprint | null {
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  for (let k = lo + 1; k < hi; k++) {
    const p = gidFromNodeId(nodeIds[k]!);
    if (p?.kind !== "space") continue;
    const space = spaceByGid(footprints, p.global_id);
    if (usableSpace(space)) return space;
  }
  return null;
}

/**
 * Room to walk for a portal↔portal overlay hop.
 *
 * Door→door uses a space node strictly between route indices. Space↔space
 * openings are tagged with hopFromIndex = first space of that hop, so a
 * door sitting next to that hop has no index strictly between them — resolve
 * the shared room as the hop endpoint adjacent to the other portal instead.
 */
function walkSpaceForPortalPair(
  nodeIds: string[],
  footprints: FootprintsDocument,
  a: {
    kind: string;
    routeIndex: number;
    hopFromIndex?: number;
  },
  b: {
    kind: string;
    routeIndex: number;
    hopFromIndex?: number;
  },
): SpaceFootprint | null {
  const between = spaceBetween(nodeIds, footprints, a.routeIndex, b.routeIndex);
  if (between) return between;

  if (a.kind === "opening" && b.kind === "opening") {
    const fromA = a.hopFromIndex ?? a.routeIndex;
    const fromB = b.hopFromIndex ?? b.routeIndex;
    // A→B then B→C: shared room is B = second space of first hop.
    if (fromB !== fromA + 1) return null;
    const mid = gidFromNodeId(nodeIds[fromA + 1]!);
    if (mid?.kind !== "space") return null;
    const space = spaceByGid(footprints, mid.global_id);
    return usableSpace(space) ? space : null;
  }

  // door/stair/lift ↔ opening (either order).
  const opening = a.kind === "opening" ? a : b.kind === "opening" ? b : null;
  const other = opening === a ? b : opening === b ? a : null;
  if (!opening || !other || !isPortalKind(other.kind) || other.kind === "opening") {
    return null;
  }
  const hopFrom = opening.hopFromIndex ?? opening.routeIndex;
  const doorIdx = other.routeIndex;
  for (const spaceIdx of [hopFrom, hopFrom + 1]) {
    if (Math.abs(spaceIdx - doorIdx) !== 1) continue;
    const parsed = gidFromNodeId(nodeIds[spaceIdx]!);
    if (parsed?.kind !== "space") continue;
    const space = spaceByGid(footprints, parsed.global_id);
    if (usableSpace(space)) return space;
  }
  return null;
}

/**
 * Build geometric path from topological node_ids + footprints.
 * Start/end spaces use centroids; intermediate hops are portal↔portal
 * through the intervening space (no mid-route space centroids).
 * Space↔space hops use opening / strip portals like doors.
 */
export function buildGeometricPath(
  nodeIds: string[],
  footprints: FootprintsDocument,
  graph?: ConnectivityGraph | null,
): GeometricPath {
  const segments: GeometricPathSegment[] = [];
  if (nodeIds.length < 2) return { complete: true, segments };

  const startSpaceId = nodeIds.find((id) => id.startsWith("space:")) ?? null;
  const endSpaceId =
    [...nodeIds].reverse().find((id) => id.startsWith("space:")) ?? null;

  let complete = true;

  const pushIncomplete = (
    storey: string | null,
    reason: string,
  ) => {
    complete = false;
    segments.push({
      storey_global_id: storey,
      points: [],
      incomplete: true,
      reason,
    });
  };

  for (let i = 0; i < nodeIds.length - 1; i++) {
    const aId = nodeIds[i]!;
    const bId = nodeIds[i + 1]!;
    const a = gidFromNodeId(aId);
    const b = gidFromNodeId(bId);
    if (!a || !b) {
      pushIncomplete(null, "malformed node id");
      continue;
    }

    // Skip intermediate space centroids: door|stair → space → door|stair
    // becomes a single portal→portal segment handled when we see the far portal.
    // Same when the far hop is space↔space (treat that heal portal like a door).
    if (isPortalKind(a.kind) && b.kind === "space") {
      const bIsTerminal = bId === startSpaceId || bId === endSpaceId;
      const next = i + 2 < nodeIds.length ? gidFromNodeId(nodeIds[i + 2]!) : null;
      if (!bIsTerminal && next && isPortalKind(next.kind)) {
        const space = spaceByGid(footprints, b.global_id);
        const fromRaw = portalPoint(footprints, a);
        const toRaw = portalPoint(footprints, next);
        if (!usableSpace(space) || !fromRaw || !toRaw) {
          pushIncomplete(
            space?.storey_global_id ?? null,
            "missing footprint for portal–portal hop",
          );
          continue;
        }
        const holes = space.holes;
        const fromPt = portalOnSpace(fromRaw, space.polygon, holes);
        const toPt = portalOnSpace(toRaw, space.polygon, holes);
        segments.push({
          storey_global_id: space.storey_global_id,
          points: localPathInSpace(fromPt, toPt, space, footprints),
          incomplete: false,
        });
        continue;
      }
      if (!bIsTerminal && next && next.kind === "space") {
        const space = spaceByGid(footprints, b.global_id);
        const fromRaw = portalPoint(footprints, a);
        const toRaw = portalBetweenSpaces(
          footprints,
          b.global_id,
          next.global_id,
          graph,
        );
        if (!usableSpace(space) || !fromRaw || !toRaw) {
          pushIncomplete(
            space?.storey_global_id ?? null,
            "missing footprint for portal–space–space hop",
          );
          continue;
        }
        const fromPt = portalOnSpace(fromRaw, space.polygon, space.holes);
        const toPt = portalOnSpace(toRaw, space.polygon, space.holes);
        segments.push({
          storey_global_id: space.storey_global_id,
          points: localPathInSpace(fromPt, toPt, space, footprints),
          incomplete: false,
        });
        continue;
      }
      if (bIsTerminal) {
        const space = spaceByGid(footprints, b.global_id);
        const fromRaw = portalPoint(footprints, a);
        if (!usableSpace(space) || !fromRaw) {
          pushIncomplete(
            space?.storey_global_id ?? null,
            "missing space footprint or portal",
          );
          continue;
        }
        const fromPt = portalOnSpace(fromRaw, space.polygon, space.holes);
        const to = polygonCentroid(space.polygon)!;
        segments.push({
          storey_global_id: space.storey_global_id,
          points: localPathInSpace(fromPt, to, space, footprints),
          incomplete: false,
        });
      }
      continue;
    }

    if (a.kind === "space" && isPortalKind(b.kind)) {
      const aIsTerminal = aId === startSpaceId || aId === endSpaceId;
      if (!aIsTerminal) {
        // Middle room → door/stair after a space↔space hop: walk heal portal→door.
        const prev = i > 0 ? gidFromNodeId(nodeIds[i - 1]!) : null;
        if (prev?.kind === "space") {
          const space = spaceByGid(footprints, a.global_id);
          const fromRaw = portalBetweenSpaces(
            footprints,
            prev.global_id,
            a.global_id,
            graph,
          );
          const toRaw = portalPoint(footprints, b);
          if (!usableSpace(space) || !fromRaw || !toRaw) {
            pushIncomplete(
              space?.storey_global_id ?? null,
              "missing footprint for space–space→portal hop",
            );
            continue;
          }
          const fromPt = portalOnSpace(fromRaw, space.polygon, space.holes);
          const toPt = portalOnSpace(toRaw, space.polygon, space.holes);
          segments.push({
            storey_global_id: space.storey_global_id,
            points: localPathInSpace(fromPt, toPt, space, footprints),
            incomplete: false,
          });
        }
        continue;
      }
      const space = spaceByGid(footprints, a.global_id);
      const toRaw = portalPoint(footprints, b);
      if (!usableSpace(space) || !toRaw) {
        pushIncomplete(
          space?.storey_global_id ?? null,
          "missing space footprint or portal",
        );
        continue;
      }
      const from = polygonCentroid(space.polygon)!;
      const toPt = portalOnSpace(toRaw, space.polygon, space.holes);
      segments.push({
        storey_global_id: space.storey_global_id,
        points: localPathInSpace(from, toPt, space, footprints),
        incomplete: false,
      });
      continue;
    }

    if (a.kind === "space" && b.kind === "space") {
      const spaceA = spaceByGid(footprints, a.global_id);
      const spaceB = spaceByGid(footprints, b.global_id);
      const portal = portalBetweenSpaces(
        footprints,
        a.global_id,
        b.global_id,
        graph,
      );
      if (!usableSpace(spaceA) || !usableSpace(spaceB) || !portal) {
        pushIncomplete(
          spaceA?.storey_global_id ?? null,
          "space–space hop missing opening / strip portal",
        );
        continue;
      }

      const aIsTerminal = aId === startSpaceId || aId === endSpaceId;
      const bIsTerminal = bId === startSpaceId || bId === endSpaceId;
      const prev = i > 0 ? gidFromNodeId(nodeIds[i - 1]!) : null;
      const next = i + 2 < nodeIds.length ? gidFromNodeId(nodeIds[i + 2]!) : null;

      // Enter A→portal when A is route start, or previous hop was not space–space
      // (door→A already handled). For pure space chains, emit A centroid→portal
      // only at the start; intermediate A is exit portal of previous hop.
      if (aIsTerminal && (!prev || prev.kind !== "space")) {
        const from = polygonCentroid(spaceA.polygon)!;
        const toPt = portalOnSpace(portal, spaceA.polygon, spaceA.holes);
        segments.push({
          storey_global_id: spaceA.storey_global_id,
          points: localPathInSpace(from, toPt, spaceA, footprints),
          incomplete: false,
        });
      } else if (prev?.kind === "space") {
        // Previous space–space left us at the shared portal; walk portal→portal
        // (or portal→end) inside A when A is the middle room.
        const prevPortal = portalBetweenSpaces(
          footprints,
          prev.global_id,
          a.global_id,
          graph,
        );
        if (prevPortal) {
          const fromPt = portalOnSpace(prevPortal, spaceA.polygon, spaceA.holes);
          const toPt = portalOnSpace(portal, spaceA.polygon, spaceA.holes);
          segments.push({
            storey_global_id: spaceA.storey_global_id,
            points: localPathInSpace(fromPt, toPt, spaceA, footprints),
            incomplete: false,
          });
        }
      }

      // Exit through portal into B toward B centroid if B is terminal end,
      // or leave portal as entry for next space–space hop.
      if (bIsTerminal && (!next || next.kind !== "space")) {
        const fromPt = portalOnSpace(portal, spaceB.polygon, spaceB.holes);
        const to = polygonCentroid(spaceB.polygon)!;
        segments.push({
          storey_global_id: spaceB.storey_global_id,
          points: localPathInSpace(fromPt, to, spaceB, footprints),
          incomplete: false,
        });
      }
    }
  }

  return { complete, segments };
}

function portalPoint(
  footprints: FootprintsDocument,
  parsed: { kind: string; global_id: string },
): Point2D | null {
  if (parsed.kind === "door") {
    return doorByGid(footprints, parsed.global_id)?.point ?? null;
  }
  if (parsed.kind === "opening") {
    const op = openingByGid(footprints, parsed.global_id);
    if (!op?.point || op.incomplete) return null;
    return op.point;
  }
  if (parsed.kind === "stair" || parsed.kind === "lift") {
    const stair = stairByGid(footprints, parsed.global_id);
    if (!usableStair(stair)) return null;
    return polygonCentroid(stair.polygon);
  }
  return null;
}

/**
 * Flatten route into a continuous polyline for one storey.
 *
 * Waypoints: start/end space centroids, door/stair/lift portals, and
 * space↔space heal openings (treated like door portals). Intermediate
 * space centroids are omitted; portal↔portal segments route inside the
 * intervening space polygon.
 */
export function continuousPolylineForStorey(
  nodeIds: string[],
  footprints: FootprintsDocument,
  storeyGlobalId: string | "all",
  graph?: ConnectivityGraph | null,
): { points: Point2D[]; incomplete: boolean; note: string } {
  const onStorey = (storey: string | null | undefined) =>
    storeyGlobalId === "all" || storey == null || storey === storeyGlobalId;

  const startSpaceId = nodeIds.find((id) => id.startsWith("space:")) ?? null;
  const endSpaceId =
    [...nodeIds].reverse().find((id) => id.startsWith("space:")) ?? null;

  type Waypoint = {
    point: Point2D;
    kind: string;
    storey: string | null;
    routeIndex: number;
    /** For opening portals on space↔space hops: first space index of the hop. */
    hopFromIndex?: number;
    space?: SpaceFootprint;
  };
  const waypoints: Waypoint[] = [];
  let incomplete = false;

  const neighborSpaceOnStorey = (idx: number): boolean => {
    for (const j of [idx - 1, idx + 1]) {
      if (j < 0 || j >= nodeIds.length) continue;
      const p = gidFromNodeId(nodeIds[j]!);
      if (p?.kind !== "space") continue;
      const sp = spaceByGid(footprints, p.global_id);
      if (sp && onStorey(sp.storey_global_id)) return true;
    }
    return false;
  };

  const pushSpaceSpacePortal = (fromIdx: number) => {
    const a = gidFromNodeId(nodeIds[fromIdx]!);
    const b = gidFromNodeId(nodeIds[fromIdx + 1]!);
    if (a?.kind !== "space" || b?.kind !== "space") return;
    const spaceA = spaceByGid(footprints, a.global_id);
    const spaceB = spaceByGid(footprints, b.global_id);
    const portal = portalBetweenSpaces(
      footprints,
      a.global_id,
      b.global_id,
      graph,
    );
    if (!portal) {
      if (
        (spaceA && onStorey(spaceA.storey_global_id)) ||
        (spaceB && onStorey(spaceB.storey_global_id))
      ) {
        incomplete = true;
      }
      return;
    }
    const storey =
      spaceA?.storey_global_id ?? spaceB?.storey_global_id ?? null;
    if (!onStorey(storey)) return;
    waypoints.push({
      point: portal,
      kind: "opening",
      storey,
      routeIndex: fromIdx,
      hopFromIndex: fromIdx,
    });
  };

  for (let i = 0; i < nodeIds.length; i++) {
    const nodeId = nodeIds[i]!;
    const parsed = gidFromNodeId(nodeId);
    if (!parsed) {
      incomplete = true;
      continue;
    }

    if (parsed.kind === "space") {
      const isTerminal = nodeId === startSpaceId || nodeId === endSpaceId;
      if (isTerminal) {
        const space = spaceByGid(footprints, parsed.global_id);
        if (!usableSpace(space) || !onStorey(space.storey_global_id)) {
          if (space && !usableSpace(space) && onStorey(space.storey_global_id)) {
            incomplete = true;
          }
        } else {
          const c = polygonCentroid(space.polygon)!;
          waypoints.push({
            point: c,
            kind: "space",
            storey: space.storey_global_id,
            routeIndex: i,
            space: space,
          });
        }
      }
      // Space↔space heal: insert opening like a door between consecutive spaces.
      if (i + 1 < nodeIds.length) {
        const next = gidFromNodeId(nodeIds[i + 1]!);
        if (next?.kind === "space") pushSpaceSpacePortal(i);
      }
      continue;
    }

    if (parsed.kind === "door") {
      const door = doorByGid(footprints, parsed.global_id);
      if (!door?.point || !onStorey(door.storey_global_id)) {
        if (door && !door.point && onStorey(door.storey_global_id)) incomplete = true;
        continue;
      }
      waypoints.push({
        point: door.point,
        kind: "door",
        storey: door.storey_global_id,
        routeIndex: i,
      });
      continue;
    }

    if (parsed.kind === "stair" || parsed.kind === "lift") {
      const stair = stairByGid(footprints, parsed.global_id);
      if (!usableStair(stair)) {
        if (stair && onStorey(stair.storey_global_id)) incomplete = true;
        continue;
      }
      const show =
        onStorey(stair.storey_global_id) || neighborSpaceOnStorey(i);
      if (!show) continue;
      const c = polygonCentroid(stair.polygon)!;
      waypoints.push({
        point: c,
        kind: parsed.kind,
        storey: stair.storey_global_id,
        routeIndex: i,
      });
    }
  }

  if (waypoints.length === 0) {
    return {
      points: [],
      incomplete: true,
      note: "No path points on this storey (missing footprints or wrong floor).",
    };
  }
  if (waypoints.length === 1) {
    return {
      points: [waypoints[0]!.point],
      incomplete: true,
      note: "Only one point on this storey — check adjacent floors for the rest of the route.",
    };
  }

  const points: Point2D[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    const mid = walkSpaceForPortalPair(nodeIds, footprints, a, b);

    let seg: Point2D[];
    if (a.kind === "space" && a.space && isPortalKind(b.kind)) {
      seg = localPathInSpace(
        a.point,
        portalOnSpace(b.point, a.space.polygon, a.space.holes),
        a.space,
        footprints,
      );
    } else if (isPortalKind(a.kind) && b.kind === "space" && b.space) {
      seg = localPathInSpace(
        portalOnSpace(a.point, b.space.polygon, b.space.holes),
        b.point,
        b.space,
        footprints,
      );
    } else if (isPortalKind(a.kind) && isPortalKind(b.kind) && mid) {
      seg = localPathInSpace(
        portalOnSpace(a.point, mid.polygon, mid.holes),
        portalOnSpace(b.point, mid.polygon, mid.holes),
        mid,
        footprints,
      );
    } else if (
      a.kind === "space" &&
      b.kind === "space" &&
      a.space &&
      a.space === b.space
    ) {
      seg = localPathInSpace(a.point, b.point, a.space, footprints);
    } else {
      // Last resort: should be rare once openings are inserted for space↔space.
      incomplete = true;
      seg = [a.point, b.point];
    }

    if (points.length && seg.length) {
      const last = points[points.length - 1]!;
      const first = seg[0]!;
      if (dist(last, first) < 1e-6) points.push(...seg.slice(1));
      else points.push(...seg);
    } else {
      points.push(...seg);
    }
  }

  return {
    points,
    incomplete,
    note: incomplete
      ? "Route overlay partial — some spaces/doors lack footprints."
      : `Route overlay · ${waypoints.length} waypoints on this floor`,
  };
}

export function pathSegmentsForStorey(
  path: GeometricPath,
  storeyGlobalId: string | "all",
): GeometricPathSegment[] {
  return path.segments.filter((seg) => {
    if (!seg.points.length || seg.incomplete) return false;
    if (storeyGlobalId === "all") return true;
    return seg.storey_global_id == null || seg.storey_global_id === storeyGlobalId;
  });
}
