import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { buildRouteShareScene } from "./route-share-scene.ts";
import { ifcPlanToThree } from "./viewer-camera-pose.ts";

const START_COLOR = 0x22c55e;
const END_COLOR = 0xef4444;
const TUBE_HEIGHT_OFFSET_M = 0.05;

function markerAt(scene: THREE.Scene, colorHex: number): THREE.Mesh {
  const mesh = scene.children.find(
    (child): child is THREE.Mesh =>
      child instanceof THREE.Mesh &&
      child.geometry instanceof THREE.SphereGeometry &&
      (child.material as THREE.MeshStandardMaterial).color.getHex() === colorHex,
  );
  assert.ok(mesh, `expected a marker mesh with color 0x${colorHex.toString(16)}`);
  return mesh;
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

  it("places start/end markers using the app's real plan<->Three convention (z = -planY), not a mirrored one", () => {
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

    // The regression this guards: an earlier version built tube/marker
    // points as `new THREE.Vector3(p.x, y, p.y)` (z = +planY) while the
    // room-slab geometry got the correct z = -planY for free via its own
    // rotateX(-90deg) extrude trick — the two disagreed, so the exported
    // path looked mirrored/backwards relative to the rooms around it.
    // Asserting against ifcPlanToThree's own output (rather than a
    // hardcoded number) means this test still passes if that shared
    // function's convention ever legitimately changes.
    const start = markerAt(scene, START_COLOR);
    assert.equal(start.position.x, expectedStart.x);
    assert.equal(start.position.y, expectedStart.y);
    assert.equal(start.position.z, expectedStart.z);

    const end = markerAt(scene, END_COLOR);
    assert.equal(end.position.x, expectedEnd.x);
    assert.equal(end.position.y, expectedEnd.y);
    assert.equal(end.position.z, expectedEnd.z);

    // The specific sign that broke: for a positive plan-Y point, world Z
    // must come out negative.
    assert.equal(expectedEnd.z, -5);
    assert.equal(end.position.z, -5);
  });
});
