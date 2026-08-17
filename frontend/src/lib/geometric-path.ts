/**
 * Level-3 geometric path: global hop list from the connectivity router,
 * local segments constrained to space polygons via door portals.
 *
 * POC local solver: coarse grid A* inside the space polygon.
 */

import type { DoorPortal, FootprintsDocument, Point2D, SpaceFootprint } from "@/types/footprints";

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

function clampPointToPolygon(p: Point2D, polygon: Point2D[]): Point2D {
  if (pointInPolygon(p.x, p.y, polygon)) return p;
  const c = polygonCentroid(polygon);
  if (!c) return p;
  let best = c;
  for (let t = 0; t <= 20; t++) {
    const u = t / 20;
    const q = { x: c.x + (p.x - c.x) * u, y: c.y + (p.y - c.y) * u };
    if (pointInPolygon(q.x, q.y, polygon)) best = q;
  }
  return best;
}

/** Grid A* inside polygon between two points. */
export function localPathInPolygon(
  start: Point2D,
  goal: Point2D,
  polygon: Point2D[],
): Point2D[] {
  const s = clampPointToPolygon(start, polygon);
  const g = clampPointToPolygon(goal, polygon);
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
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const cell = Math.max(span / 24, 0.25);
  const cols = Math.max(2, Math.ceil((maxX - minX) / cell) + 1);
  const rows = Math.max(2, Math.ceil((maxY - minY) / cell) + 1);

  const key = (c: number, r: number) => `${c},${r}`;
  const inPoly = (c: number, r: number) =>
    pointInPolygon(minX + c * cell, minY + r * cell, polygon);

  const toCell = (p: Point2D) => ({
    c: Math.max(0, Math.min(cols - 1, Math.round((p.x - minX) / cell))),
    r: Math.max(0, Math.min(rows - 1, Math.round((p.y - minY) / cell))),
  });

  const startCell = toCell(s);
  const goalCell = toCell(g);

  type Node = { c: number; r: number; g: number; f: number };
  const open: Node[] = [
    {
      c: startCell.c,
      r: startCell.r,
      g: 0,
      f: Math.hypot(goalCell.c - startCell.c, goalCell.r - startCell.r),
    },
  ];
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
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift()!;
    const ck = key(cur.c, cur.r);
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (cur.c === goalCell.c && cur.r === goalCell.r) {
      const path: Point2D[] = [g];
      let k: string | undefined = ck;
      while (k && k !== key(startCell.c, startCell.r)) {
        const [cs, rs] = k.split(",").map(Number) as [number, number];
        path.push({ x: minX + cs * cell, y: minY + rs * cell });
        k = came.get(k);
      }
      path.push(s);
      path.reverse();
      return path;
    }
    for (const [dc, dr] of neighbors) {
      const nc = cur.c + dc!;
      const nr = cur.r + dr!;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      if (!inPoly(nc, nr) && !(nc === goalCell.c && nr === goalCell.r)) continue;
      const nk = key(nc, nr);
      const tentative = cur.g + Math.hypot(dc!, dr!);
      if (tentative >= (gScore.get(nk) ?? Infinity)) continue;
      came.set(nk, ck);
      gScore.set(nk, tentative);
      open.push({
        c: nc,
        r: nr,
        g: tentative,
        f: tentative + Math.hypot(goalCell.c - nc, goalCell.r - nr),
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

function usableSpace(s: SpaceFootprint | undefined): s is SpaceFootprint {
  return Boolean(s && !s.incomplete && s.polygon.length >= 3);
}

/**
 * Build geometric path from topological node_ids + footprints.
 * Walks consecutive pairs: space↔door uses in-polygon local path.
 */
export function buildGeometricPath(
  nodeIds: string[],
  footprints: FootprintsDocument,
): GeometricPath {
  const segments: GeometricPathSegment[] = [];
  if (nodeIds.length < 2) return { complete: true, segments };

  let complete = true;

  for (let i = 0; i < nodeIds.length - 1; i++) {
    const a = gidFromNodeId(nodeIds[i]!);
    const b = gidFromNodeId(nodeIds[i + 1]!);
    if (!a || !b) {
      complete = false;
      segments.push({
        storey_global_id: null,
        points: [],
        incomplete: true,
        reason: "malformed node id",
      });
      continue;
    }

    if (a.kind === "space" && b.kind === "door") {
      const space = spaceByGid(footprints, a.global_id);
      const door = doorByGid(footprints, b.global_id);
      if (!usableSpace(space) || !door?.point) {
        complete = false;
        segments.push({
          storey_global_id: space?.storey_global_id ?? door?.storey_global_id ?? null,
          points: [],
          incomplete: true,
          reason: "missing space footprint or door portal",
        });
        continue;
      }
      const from = polygonCentroid(space.polygon)!;
      segments.push({
        storey_global_id: space.storey_global_id,
        points: localPathInPolygon(from, door.point, space.polygon),
        incomplete: false,
      });
      continue;
    }

    if (a.kind === "door" && b.kind === "space") {
      const door = doorByGid(footprints, a.global_id);
      const space = spaceByGid(footprints, b.global_id);
      if (!usableSpace(space) || !door?.point) {
        complete = false;
        segments.push({
          storey_global_id: space?.storey_global_id ?? door?.storey_global_id ?? null,
          points: [],
          incomplete: true,
          reason: "missing space footprint or door portal",
        });
        continue;
      }
      const to = polygonCentroid(space.polygon)!;
      segments.push({
        storey_global_id: space.storey_global_id,
        points: localPathInPolygon(door.point, to, space.polygon),
        incomplete: false,
      });
      continue;
    }

    if (a.kind === "space" && (b.kind === "stair" || b.kind === "lift")) {
      const space = spaceByGid(footprints, a.global_id);
      const c = usableSpace(space) ? polygonCentroid(space.polygon) : null;
      if (!c) {
        complete = false;
        segments.push({
          storey_global_id: space?.storey_global_id ?? null,
          points: [],
          incomplete: true,
          reason: "vertical hop without space footprint",
        });
      } else {
        segments.push({
          storey_global_id: space!.storey_global_id,
          points: [c],
          incomplete: false,
        });
      }
      continue;
    }

    if (a.kind === "space" && b.kind === "space") {
      complete = false;
      segments.push({
        storey_global_id: spaceByGid(footprints, a.global_id)?.storey_global_id ?? null,
        points: [],
        incomplete: true,
        reason: "space–space hop missing door portal in route",
      });
    }
  }

  return { complete, segments };
}

/**
 * Flatten route into a continuous polyline for one storey.
 * Prefers in-polygon local paths for space↔door hops; falls back to
 * connecting centroids/portals so the overlay is always visible when
 * geometry exists.
 */
export function continuousPolylineForStorey(
  nodeIds: string[],
  footprints: FootprintsDocument,
  storeyGlobalId: string | "all",
): { points: Point2D[]; incomplete: boolean; note: string } {
  const onStorey = (storey: string | null | undefined) =>
    storeyGlobalId === "all" || storey == null || storey === storeyGlobalId;

  type Waypoint = { point: Point2D; kind: string; spacePolygon?: Point2D[]; storey: string | null };
  const waypoints: Waypoint[] = [];
  let incomplete = false;

  for (const nodeId of nodeIds) {
    const parsed = gidFromNodeId(nodeId);
    if (!parsed) {
      incomplete = true;
      continue;
    }
    if (parsed.kind === "space") {
      const space = spaceByGid(footprints, parsed.global_id);
      if (!usableSpace(space) || !onStorey(space.storey_global_id)) {
        if (space && !usableSpace(space) && onStorey(space.storey_global_id)) incomplete = true;
        continue;
      }
      const c = polygonCentroid(space.polygon)!;
      waypoints.push({
        point: c,
        kind: "space",
        spacePolygon: space.polygon,
        storey: space.storey_global_id,
      });
    } else if (parsed.kind === "door") {
      const door = doorByGid(footprints, parsed.global_id);
      if (!door?.point || !onStorey(door.storey_global_id)) {
        if (door && !door.point && onStorey(door.storey_global_id)) incomplete = true;
        continue;
      }
      waypoints.push({
        point: door.point,
        kind: "door",
        storey: door.storey_global_id,
      });
    } else if (parsed.kind === "stair" || parsed.kind === "lift") {
      // Mark vertical transition using previous space centroid already on the list;
      // if none, skip (no freestanding geometry for stair in footprints POC).
      continue;
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
    let seg: Point2D[];
    if (a.kind === "space" && a.spacePolygon && b.kind === "door") {
      seg = localPathInPolygon(a.point, b.point, a.spacePolygon);
    } else if (a.kind === "door" && b.kind === "space" && b.spacePolygon) {
      seg = localPathInPolygon(a.point, b.point, b.spacePolygon);
    } else if (a.kind === "space" && b.kind === "space" && a.spacePolygon === b.spacePolygon && a.spacePolygon) {
      seg = localPathInPolygon(a.point, b.point, a.spacePolygon);
    } else {
      // Door–door or cross-room: straight connector (still visible).
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
    // Include null-storey segments so overlays are not silently dropped.
    return seg.storey_global_id == null || seg.storey_global_id === storeyGlobalId;
  });
}
