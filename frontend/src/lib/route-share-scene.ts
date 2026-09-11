/**
 * Build a small, self-contained Three.js scene for one computed route: the
 * walls/rooms it passes through (extruded to a real height, not just flat
 * floor outlines — a "navmesh"-flat export undersold what should read as an
 * actual building) plus the route itself as a tube, stacked by real storey
 * elevation. Meant to be exported via GLTFExporter and shared as a
 * standalone GLB.
 */
import * as THREE from "three";
import { normalizeElevationsToMetres } from "@/lib/storey-elevations";
import { ifcPlanToThree } from "@/lib/viewer-camera-pose";
import type { FootprintsDocument, Point2D } from "@/types/footprints";
import type { NavmeshRoute } from "@/state/infer-store";

const ROOM_COLOR = 0xcbd5e1;
const WALL_COLOR = 0xe7e2d8;
const FURNITURE_COLOR = 0x0d9488;
const TUBE_COLOR = 0x1d4ed8;
const START_COLOR = 0x22c55e;
const END_COLOR = 0xef4444;
const TUBE_RADIUS_M = 0.12;
const TUBE_HEIGHT_OFFSET_M = 0.05;
const MARKER_RADIUS_M = 0.22;
const ROOM_SLAB_HEIGHT_M = 0.03;
/** Real wall height isn't in the footprint schema (2D polygons only) — a
 * typical ceiling height so the export reads as a building, not a floorplan. */
const WALL_HEIGHT_M = 2.4;
/** Furniture height isn't in the schema either (plan-only obstacle extraction) —
 * a generic desk/cabinet height, shorter than a wall so the route tube stays
 * visible passing beside it rather than reading as another wall. */
const FURNITURE_HEIGHT_M = 0.75;

type StoreySegment = { storeyId: string; points: Point2D[] };

function routeSegments(route: NavmeshRoute): StoreySegment[] {
  if (route.segments?.length) return route.segments;
  if (route.points?.length) return [{ storeyId: route.storeyId, points: route.points }];
  return [];
}

/** Real storey elevations in metres, keyed by global_id — same normalization route-tube.ts uses. */
function storeyElevationsM(footprints: FootprintsDocument): Map<string, number> {
  const raw = footprints.storeys ?? [];
  const withElev = raw.filter(
    (s): s is { global_id: string; name: string; elevation: number } =>
      s.elevation != null && Number.isFinite(s.elevation),
  );
  const { metres } = normalizeElevationsToMetres(withElev.map((s) => s.elevation));
  const map = new Map<string, number>();
  withElev.forEach((s, i) => map.set(s.global_id, metres[i]!));
  return map;
}

/**
 * Plan XY (metres) + elevation -> Three.js world position (Y-up). Reuses the
 * app's one established plan<->Three conversion — the live 3D viewer and the
 * on-screen navmesh route tube both go through this same function — instead
 * of a hand-rolled mapping. Getting its z = -y flip wrong is exactly what
 * made an earlier version of this export show the route mirrored relative
 * to the rooms around it (the rooms happened to get the flip right via a
 * geometry-rotation side effect; the route's point positions didn't).
 */
function planPoint(x: number, y: number, elevationM: number): THREE.Vector3 {
  const p = ifcPlanToThree(x, y, elevationM);
  return new THREE.Vector3(p.x, p.y, p.z);
}

/**
 * Extrude a flat plan polygon into a vertical prism from `elevationM` up by
 * `heightM`. The shape is built with local Y = +planY (NOT flipped to match
 * planPoint's z = -planY) on purpose: ExtrudeGeometry builds the shape at
 * local Z=0 and extrudes to local Z=height, and rotateX(-90deg) below maps
 * local (X, Y, Z) -> world (X, Z, -Y) -- that rotation already applies the
 * same negation planPoint applies explicitly. Flipping the shape's Y here
 * too would cancel it back out and reintroduce the mirror bug.
 */
function prism(polygon: Point2D[], elevationM: number, heightM: number, color: number): THREE.Mesh {
  const shape = new THREE.Shape(polygon.map((p) => new THREE.Vector2(p.x, p.y)));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(heightM, 0.01),
    bevelEnabled: false,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, elevationM, 0);
  const material = new THREE.MeshStandardMaterial({
    color,
    side: THREE.DoubleSide,
    roughness: 0.9,
  });
  return new THREE.Mesh(geometry, material);
}

function routeTube(points: Point2D[], elevationM: number): THREE.Mesh | null {
  if (points.length < 2) return null;
  const y = elevationM + TUBE_HEIGHT_OFFSET_M;
  const curve = new THREE.CatmullRomCurve3(points.map((p) => planPoint(p.x, p.y, y)));
  const segments = Math.max(points.length * 4, 8);
  const geometry = new THREE.TubeGeometry(curve, segments, TUBE_RADIUS_M, 8, false);
  const material = new THREE.MeshStandardMaterial({ color: TUBE_COLOR, roughness: 0.4 });
  return new THREE.Mesh(geometry, material);
}

function marker(point: Point2D, elevationM: number, color: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(MARKER_RADIUS_M, 16, 16);
  const material = new THREE.MeshStandardMaterial({ color });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(planPoint(point.x, point.y, elevationM + TUBE_HEIGHT_OFFSET_M));
  return mesh;
}

/**
 * Null when the route has no drawable points on any storey (e.g. an
 * in-progress route with only a start pin) — nothing worth exporting yet.
 */
export function buildRouteShareScene(
  route: NavmeshRoute,
  footprints: FootprintsDocument,
): THREE.Scene | null {
  const segments = routeSegments(route).filter((s) => s.points.length >= 2);
  if (!segments.length) return null;

  const elevations = storeyElevationsM(footprints);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 8, 4);
  scene.add(sun);

  // A wall with no storey_global_id is shown "on every storey" elsewhere in
  // the app (FloorplanViewer); here every segment renders simultaneously in
  // one scene, so add each such wall once (at the first segment it matches)
  // instead of stacking a duplicate copy at every storey's elevation.
  const wallsAdded = new Set<string>();
  const furnitureAdded = new Set<string>();

  for (const segment of segments) {
    const elevationM = elevations.get(segment.storeyId) ?? 0;

    for (const space of footprints.spaces) {
      if (space.incomplete || space.polygon.length < 3) continue;
      if (space.storey_global_id !== segment.storeyId) continue;
      scene.add(prism(space.polygon, elevationM, ROOM_SLAB_HEIGHT_M, ROOM_COLOR));
    }

    for (const wall of footprints.walls ?? []) {
      if (wall.incomplete || wall.polygon.length < 3) continue;
      if (wall.storey_global_id != null && wall.storey_global_id !== segment.storeyId) continue;
      if (wallsAdded.has(wall.global_id)) continue;
      wallsAdded.add(wall.global_id);
      scene.add(prism(wall.polygon, elevationM, WALL_HEIGHT_M, WALL_COLOR));
    }

    for (const item of footprints.furniture ?? []) {
      if (item.incomplete || item.polygon.length < 3) continue;
      if (item.storey_global_id != null && item.storey_global_id !== segment.storeyId) continue;
      if (furnitureAdded.has(item.global_id)) continue;
      furnitureAdded.add(item.global_id);
      scene.add(prism(item.polygon, elevationM, FURNITURE_HEIGHT_M, FURNITURE_COLOR));
    }

    const tube = routeTube(segment.points, elevationM);
    if (tube) scene.add(tube);
  }

  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  scene.add(marker(first.points[0]!, elevations.get(first.storeyId) ?? 0, START_COLOR));
  scene.add(
    marker(last.points[last.points.length - 1]!, elevations.get(last.storeyId) ?? 0, END_COLOR),
  );

  return scene;
}
