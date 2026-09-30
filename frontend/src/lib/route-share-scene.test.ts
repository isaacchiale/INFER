import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { buildRouteShareScene } from "./route-share-scene.ts";
import { ifcPlanToThree } from "./viewer-camera-pose.ts";

const DOOR_COLOR = 0xf59e0b;
const TUBE_HEIGHT_OFFSET_M = 0.05;

/** The tube's cross-section is a regular ring of vertices around the
 * centerline at each point along the curve — averaging one full ring
 * exactly cancels the radius offset, recovering the true centerline point. */
function tubeRingCenter(
  tube: THREE.Mesh,
  ringIndex: number,
  radialSegments: number,
): THREE.Vector3 {
  const position = tube.geometry.getAttribute("position") as THREE.BufferAttribute;
  const center = new THREE.Vector3();
  for (let i = 0; i < radialSegments; i++) {
    const vertexIndex = ringIndex * (radialSegments + 1) + i;
    center.add(
      new THREE.Vector3(
        position.getX(vertexIndex),
        position.getY(vertexIndex),
        position.getZ(vertexIndex),
      ),
    );
  }
  return center.divideScalar(radialSegments);
}

describe("buildRouteShareScene", () => {
  it("returns null for a route with no drawable points", () => {
    const footprints = { storeys: [], spaces: [], doors: [] } as never;
    const route = {
      storeyId: "st1",
      start: { x: 0, y: 0 },
      end: null,
      endStoreyId: null,
      points: null,
      segments: null,
    } as never;
    assert.equal(buildRouteShareScene(route, footprints), null);
  });

  it("places the route tube using the app's real plan<->Three convention (z = -planY), not a mirrored one", () => {
    const footprints = {
      storeys: [{ global_id: "st1", name: "L1", elevation: 0 }],
      spaces: [],
      doors: [],
      walls: [],
    } as never;
    const route = {
      storeyId: "st1",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 5 },
      endStoreyId: "st1",
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 5 },
      ],
      segments: null,
    } as never;

    const scene = buildRouteShareScene(route, footprints);
    assert.ok(scene, "expected a scene for a route with two points");

    const expectedStart = ifcPlanToThree(0, 0, TUBE_HEIGHT_OFFSET_M);
    const expectedEnd = ifcPlanToThree(0, 5, TUBE_HEIGHT_OFFSET_M);

    // The regression this guards: an earlier version built tube points as
    // `new THREE.Vector3(p.x, y, p.y)` (z = +planY) while the room-slab
    // geometry got the correct z = -planY for free via its own
    // rotateX(-90deg) extrude trick — the two disagreed, so the exported
    // path looked mirrored/backwards relative to the rooms around it.
    // Asserting against ifcPlanToThree's own output (rather than a
    // hardcoded number) means this test still passes if that shared
    // function's convention ever legitimately changes.
    const tube = scene!.children.find(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh && child.geometry instanceof THREE.TubeGeometry,
    );
    assert.ok(tube, "expected a route tube mesh");

    // routeTube() passes Math.max(points.length * 4, 8) as tubularSegments
    // and the literal 8 as radialSegments — a 2-point route gives exactly 8
    // rings (0..8), the first and last being the curve's true endpoints.
    const radialSegments = 8;
    const tubularSegments = 8;
    const start = tubeRingCenter(tube, 0, radialSegments);
    const end = tubeRingCenter(tube, tubularSegments, radialSegments);

    assert.ok(Math.abs(start.x - expectedStart.x) < 1e-5);
    assert.ok(Math.abs(start.y - expectedStart.y) < 1e-5);
    assert.ok(Math.abs(start.z - expectedStart.z) < 1e-5);

    assert.ok(Math.abs(end.x - expectedEnd.x) < 1e-5);
    assert.ok(Math.abs(end.y - expectedEnd.y) < 1e-5);
    assert.ok(Math.abs(end.z - expectedEnd.z) < 1e-5);

    // The specific sign that broke: for a positive plan-Y point, world Z
    // must come out negative.
    assert.equal(expectedEnd.z, -5);
    assert.ok(Math.abs(end.z - -5) < 1e-5);
  });

  it("draws a door with a measured polygon as an extruded box, not just a marker", () => {
    const footprints = {
      storeys: [{ global_id: "st1", name: "L1", elevation: 0 }],
      spaces: [],
      walls: [],
      doors: [
        {
          global_id: "d1",
          name: "Door 1",
          storey_global_id: "st1",
          point: { x: 1, y: 1 },
          segment: [],
          polygon: [
            { x: 0.9, y: 0.9 },
            { x: 1.1, y: 0.9 },
            { x: 1.1, y: 1.1 },
            { x: 0.9, y: 1.1 },
          ],
          incomplete: false,
          method: "ifc_mesh_xy_centroid",
        },
      ],
    } as never;
    const route = {
      storeyId: "st1",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 5 },
      endStoreyId: "st1",
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 5 },
      ],
      segments: null,
    } as never;

    const scene = buildRouteShareScene(route, footprints);
    assert.ok(scene);
    const doorMesh = scene!.children.find(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh &&
        child.geometry instanceof THREE.ExtrudeGeometry &&
        (child.material as THREE.MeshStandardMaterial).color.getHex() === DOOR_COLOR,
    );
    assert.ok(doorMesh, "expected an extruded door mesh");
  });

  it("falls back to a marker sphere for a door with only a point (no measured width)", () => {
    const footprints = {
      storeys: [{ global_id: "st1", name: "L1", elevation: 0 }],
      spaces: [],
      walls: [],
      doors: [
        {
          global_id: "d1",
          name: "Door 1",
          storey_global_id: "st1",
          point: { x: 1, y: 1 },
          segment: [],
          incomplete: false,
          method: "ifc_mesh_xy_centroid",
        },
      ],
    } as never;
    const route = {
      storeyId: "st1",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 5 },
      endStoreyId: "st1",
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 5 },
      ],
      segments: null,
    } as never;

    const scene = buildRouteShareScene(route, footprints);
    assert.ok(scene);
    const doorMesh = scene!.children.find(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh &&
        child.geometry instanceof THREE.SphereGeometry &&
        (child.material as THREE.MeshStandardMaterial).color.getHex() === DOOR_COLOR,
    );
    assert.ok(doorMesh, "expected a door marker sphere");
  });

  it("excludes an incomplete door", () => {
    const footprints = {
      storeys: [{ global_id: "st1", name: "L1", elevation: 0 }],
      spaces: [],
      walls: [],
      doors: [
        {
          global_id: "d1",
          name: "Door 1",
          storey_global_id: "st1",
          point: { x: 1, y: 1 },
          segment: [],
          incomplete: true,
          method: "unavailable",
        },
      ],
    } as never;
    const route = {
      storeyId: "st1",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 5 },
      endStoreyId: "st1",
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 5 },
      ],
      segments: null,
    } as never;

    const scene = buildRouteShareScene(route, footprints);
    assert.ok(scene);
    const doorMesh = scene!.children.find(
      (child) =>
        child instanceof THREE.Mesh &&
        (child.material as THREE.MeshStandardMaterial).color?.getHex?.() === DOOR_COLOR,
    );
    assert.equal(doorMesh, undefined);
  });
});
