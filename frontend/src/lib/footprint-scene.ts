/**
 * Live 3D pane render path for models with no BIM/IFC geometry to load
 * through That Open (web-ifc only parses actual IFC bytes) — currently
 * IndoorGML. Builds a flat-extrusion "2.5D" scene straight from the
 * FootprintsDocument every format already has to produce, reusing the same
 * prism/planPoint construction the GLB route-share export already proved
 * out (see route-share-scene.ts) rather than a second implementation of
 * the same plan-to-Three lift.
 *
 * Deliberately not the same visual fidelity as an IFC model loaded through
 * That Open (no real wall thickness, window openings, or materials) — an
 * honest reflection of what a plan-only footprint format actually contains.
 */
import * as THREE from "three";
import { planPoint, prism, storeyElevationsM } from "@/lib/route-share-scene";
import type { FootprintsDocument } from "@/types/footprints";

const ROOM_COLOR = 0xcbd5e1;
const ROOM_SLAB_HEIGHT_M = 2.6;
const DOOR_MARKER_COLOR = 0xf59e0b;
const DOOR_MARKER_RADIUS_M = 0.15;

export type FootprintSceneResult = {
  scene: THREE.Scene;
  bounds: THREE.Box3;
};

/**
 * Renders every space on every storey (storey filtering, matching the IFC
 * path's "All levels" dropdown, is a call-site concern — swap the whole
 * scene when the filter changes rather than mutate it in place, same as
 * the IFC path reloads on storey filter changes today).
 */
export function buildFootprintScene(
  footprints: FootprintsDocument,
  activeStoreyId: string | "all",
): FootprintSceneResult | null {
  const spaces = (footprints.spaces ?? []).filter(
    (s) => !s.incomplete && s.polygon.length >= 3,
  );
  if (!spaces.length) return null;

  const elevations = storeyElevationsM(footprints);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 8, 4);
  scene.add(sun);

  const bounds = new THREE.Box3();
  let added = 0;

  for (const space of spaces) {
    if (activeStoreyId !== "all" && space.storey_global_id !== activeStoreyId) continue;
    const elevationM = space.storey_global_id ? (elevations.get(space.storey_global_id) ?? 0) : 0;
    const mesh = prism(space.polygon, elevationM, ROOM_SLAB_HEIGHT_M, ROOM_COLOR);
    scene.add(mesh);
    bounds.expandByObject(mesh);
    added += 1;
  }

  for (const door of footprints.doors ?? []) {
    if (door.incomplete || !door.point) continue;
    if (activeStoreyId !== "all" && door.storey_global_id !== activeStoreyId) continue;
    const elevationM = door.storey_global_id ? (elevations.get(door.storey_global_id) ?? 0) : 0;
    const geometry = new THREE.SphereGeometry(DOOR_MARKER_RADIUS_M, 12, 12);
    const material = new THREE.MeshStandardMaterial({ color: DOOR_MARKER_COLOR });
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(planPoint(door.point.x, door.point.y, elevationM + 1.0));
    scene.add(marker);
    bounds.expandByObject(marker);
  }

  if (!added) return null;
  return { scene, bounds };
}
