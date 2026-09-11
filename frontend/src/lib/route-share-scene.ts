/**
 * Build a small, self-contained Three.js scene for one computed route —
 * the rooms it passes through (as flat slabs, for spatial context) plus the
 * route itself as a tube, stacked by real storey elevation. Meant to be
 * exported via GLTFExporter and shared as a standalone GLB, so it does NOT
 * reuse the live viewer's coordination-matrix/model-bounds alignment (there
 * is no live mesh on the receiving end) — it maps footprint plan XY (metres)
 * directly to a fresh Y-up scene.
 */
import * as THREE from "three";
import { normalizeElevationsToMetres } from "@/lib/storey-elevations";
import type { FootprintsDocument, Point2D } from "@/types/footprints";
import type { NavmeshRoute } from "@/state/infer-store";

const ROOM_COLOR = 0xcbd5e1;
const TUBE_COLOR = 0x1d4ed8;
const START_COLOR = 0x22c55e;
const END_COLOR = 0xef4444;
const TUBE_RADIUS_M = 0.12;
const TUBE_HEIGHT_OFFSET_M = 0.05;
const MARKER_RADIUS_M = 0.22;

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

function roomSlab(polygon: Point2D[], elevationM: number): THREE.Mesh {
  const shape = new THREE.Shape(polygon.map((p) => new THREE.Vector2(p.x, p.y)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2); // extruded along local Z → world Y (up)
  geometry.translate(0, elevationM, 0);
  const material = new THREE.MeshStandardMaterial({
    color: ROOM_COLOR,
    side: THREE.DoubleSide,
    roughness: 0.9,
  });
  return new THREE.Mesh(geometry, material);
}

function routeTube(points: Point2D[], elevationM: number): THREE.Mesh | null {
  if (points.length < 2) return null;
  const y = elevationM + TUBE_HEIGHT_OFFSET_M;
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p.x, y, p.y)));
  const segments = Math.max(points.length * 4, 8);
  const geometry = new THREE.TubeGeometry(curve, segments, TUBE_RADIUS_M, 8, false);
  const material = new THREE.MeshStandardMaterial({ color: TUBE_COLOR, roughness: 0.4 });
  return new THREE.Mesh(geometry, material);
}

function marker(point: Point2D, elevationM: number, color: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(MARKER_RADIUS_M, 16, 16);
  const material = new THREE.MeshStandardMaterial({ color });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(point.x, elevationM + TUBE_HEIGHT_OFFSET_M, point.y);
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

  for (const segment of segments) {
    const elevationM = elevations.get(segment.storeyId) ?? 0;
    for (const space of footprints.spaces) {
      if (space.incomplete || space.polygon.length < 3) continue;
      if (space.storey_global_id !== segment.storeyId) continue;
      scene.add(roomSlab(space.polygon, elevationM));
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
