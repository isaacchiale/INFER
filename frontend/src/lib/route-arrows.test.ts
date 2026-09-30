import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import { strFromU8, unzipSync } from "three/addons/libs/fflate.module.js";
import { buildRouteArrows, collectRouteTubes, ROUTE_ARROW_LOOP_S } from "./route-arrows.ts";

/** Straight 10 m tube along +X at y = 2, radius 0.3. */
function straightTube(length = 10, radius = 0.3): THREE.Mesh {
  const curve = new THREE.LineCurve3(new THREE.Vector3(0, 2, 0), new THREE.Vector3(length, 2, 0));
  return new THREE.Mesh(new THREE.TubeGeometry(curve, 8, radius, 8, false));
}

function frame(clip: THREE.AnimationClip, name: string, prop: string, key: number): number[] {
  const track = clip.tracks.find((t) => t.name === `${name}.${prop}`)!;
  const size = track.getValueSize();
  return Array.from(track.values.slice(key * size, key * size + size));
}

describe("buildRouteArrows", () => {
  it("spaces chevrons along the tube, one clip shared by all, unique node names", () => {
    const result = buildRouteArrows(collectRouteTubes([straightTube(10)]))!;
    assert.ok(result);
    // 10 m / 2.5 m spacing.
    assert.equal(result.group.children.length, 4);
    const names = result.group.children.map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(result.clip.duration, ROUTE_ARROW_LOOP_S);
    assert.equal(result.clip.tracks.length, 4 * 3);
  });

  it("rides on top of the tube and moves toward the route's end", () => {
    const { clip } = buildRouteArrows(collectRouteTubes([straightTube(10, 0.3)]))!;
    const start = frame(clip, "route-arrow-0-1", "position", 0);
    const end = frame(clip, "route-arrow-0-1", "position", 24);
    assert.ok(Math.abs(start[1]! - 2.3) < 1e-6, "y = tube centre + radius");
    assert.ok(end[0]! - start[0]! > 2.4, "advances one spacing along +X");
  });

  it("loops seamlessly: each visible chevron's end pose is the next one's start pose", () => {
    const { clip } = buildRouteArrows(collectRouteTubes([straightTube(10)]))!;
    for (let n = 0; n < 3; n++) {
      const endPos = frame(clip, `route-arrow-0-${n}`, "position", 24);
      const nextStart = frame(clip, `route-arrow-0-${n + 1}`, "position", 0);
      endPos.forEach((v, i) => assert.ok(Math.abs(v - nextStart[i]!) < 1e-6));
    }
    // First grows in from nothing, last shrinks out to nothing.
    assert.ok(frame(clip, "route-arrow-0-0", "scale", 0)[0]! < 0.01);
    assert.ok(frame(clip, "route-arrow-0-3", "scale", 24)[0]! < 0.01);
  });

  it("points each chevron along the direction of travel", () => {
    const { clip } = buildRouteArrows(collectRouteTubes([straightTube(10)]))!;
    const [x, y, z, w] = frame(clip, "route-arrow-0-1", "quaternion", 5);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(x, y, z, w));
    assert.ok(forward.x > 0.999, `chevron +Z should face +X, got ${forward.toArray()}`);
  });

  it("returns null when no tube is long enough for a chevron", () => {
    assert.equal(buildRouteArrows(collectRouteTubes([straightTube(1)])), null);
  });

  it("bakes into USDZ as animated time samples", async () => {
    const scene = new THREE.Scene();
    const tube = straightTube(10);
    scene.add(tube);
    const arrows = buildRouteArrows(collectRouteTubes([tube]))!;
    scene.add(arrows.group);
    const bytes = await new USDZExporter().parseAsync(scene, { animations: [arrows.clip] });
    const files = unzipSync(bytes);
    const usda = strFromU8(files[Object.keys(files).find((f) => f.endsWith(".usda"))!]!);
    assert.match(usda, /xformOp:translate\.timeSamples/);
    assert.match(usda, /endTimeCode = /);
  });
});
