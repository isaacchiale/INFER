import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyMat4Point,
  coordinatedToIfcPlan,
  ifcElevationFromThree,
  ifcPlanToThree,
  invertMat4,
  liftPlanPolylineToThree,
  planHeadingFromThree,
  planTranslationFromCentres,
  pointInBuildingBounds,
  resolveCoordAxisFrame,
  storeyIdForElevation,
  threeAabbCentre,
  threePositionToPlanPose,
  threeToIfcPlanResolved,
  threeYFromIfcElevation,
} from "./viewer-camera-pose.ts";

describe("viewer-camera-pose", () => {
  it("maps Three Y-up to IFC plan XY via web-ifc inverse", () => {
    const pose = threePositionToPlanPose({ x: 10, y: 4.2, z: -3 }, { x: 0, y: 0, z: -1 });
    assert.equal(pose.x, 10);
    assert.equal(pose.y, 3);
    assert.equal(pose.elevation, 4.2);
    assert.equal(pose.forward.z, -1);
  });

  it("maps Three look direction to plan heading", () => {
    const eye = { x: 0, y: 1.6, z: 0 };
    // Look along −Z in Three ⇒ +Y in plan (y = -z).
    const hPosY = planHeadingFromThree(eye, { x: 0, y: 0, z: -1 }, null, null);
    assert.ok(Math.abs(hPosY - Math.PI / 2) < 1e-6);
    // Look along +X ⇒ heading 0.
    const hPosX = planHeadingFromThree(eye, { x: 1, y: 0, z: 0 }, null, null);
    assert.ok(Math.abs(hPosX) < 1e-6);
  });

  it("picks storey band by elevation", () => {
    const storeys = [
      { global_id: "L0", elevation: 0 },
      { global_id: "L1", elevation: 3.5 },
      { global_id: "L2", elevation: 7 },
    ];
    assert.equal(storeyIdForElevation(storeys, 0.5), "L0");
    assert.equal(storeyIdForElevation(storeys, 3.5), "L1");
    assert.equal(storeyIdForElevation(storeys, 6.9), "L1");
    assert.equal(storeyIdForElevation(storeys, 7.2), "L2");
  });

  it("handles tightly spaced storeys via nearest-band fallback", () => {
    const storeys = [
      { global_id: "L1", elevation: 55.5 },
      { global_id: "P", elevation: 58.9 },
      { global_id: "L2", elevation: 59.7 },
    ];
    assert.equal(storeyIdForElevation(storeys, 57.1), "L1");
    assert.equal(storeyIdForElevation(storeys, 58.95), "P");
    assert.equal(storeyIdForElevation(storeys, 59.75), "L2");
  });

  it("checks building AABB with margin", () => {
    const b = { minX: 0, maxX: 10, minY: 0, maxY: 20 };
    assert.equal(pointInBuildingBounds(5, 10, b), true);
    assert.equal(pointInBuildingBounds(-1.5, 10, b), true);
    assert.equal(pointInBuildingBounds(-3, 10, b), false);
  });

  it("undoes a pure translation coordination matrix into IFC plan", () => {
    // COORDINATE_TO_ORIGIN: three = yup(ifc) - origin, origin=(100, 2, 50) in Y-up.
    // Inverse translation +100,+2,+50. Camera at Three (1, 1.5, -3).
    const inv = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      100, 2, 50, 1,
    ];
    const world = applyMat4Point({ x: 1, y: 1.5, z: -3 }, inv);
    assert.equal(world.x, 101);
    assert.equal(world.y, 3.5);
    assert.equal(world.z, 47);
    // Still Y-up (|z| large): plan (x, -z)
    const plan = coordinatedToIfcPlan(world);
    assert.equal(plan.x, 101);
    assert.equal(plan.y, -47);
    assert.equal(plan.elevation, 3.5);

    const resolved = threeToIfcPlanResolved({ x: 1, y: 1.5, z: -3 }, inv, null);
    assert.equal(resolved.x, 101);
    assert.equal(resolved.y, -47);
  });

  it("interprets restored Z-up IFC coords when |Y| dominates", () => {
    const plan = coordinatedToIfcPlan({ x: 219900, y: 907170, z: 59 });
    assert.equal(plan.x, 219900);
    assert.equal(plan.y, 907170);
    assert.equal(plan.elevation, 59);
  });

  it("keeps one axis frame across a walk instead of flipping per sample", () => {
    // Y-up model whose undone coords straddle the |Y| > |Z| heuristic: a camera
    // at eye height 60m reads Z-up in the north wing and Y-up in the south.
    const inv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const modelBounds = { minX: 0, maxX: 30, minY: 58, maxY: 62, minZ: -80, maxZ: 0 };
    const footprints = { minX: 0, maxX: 30, minY: 0, maxY: 80 };
    const frame = resolveCoordAxisFrame(inv, modelBounds, footprints);
    assert.equal(frame, "yup");

    const northWing = { x: 15, y: 60, z: -20 };
    const southWing = { x: 15, y: 60, z: -70 };
    // Unpinned, the two ends disagree about which axis is up.
    assert.notEqual(
      coordinatedToIfcPlan(northWing).elevation,
      coordinatedToIfcPlan(southWing).elevation,
    );
    // Pinned to the model frame, elevation stays put and plan Y tracks the walk.
    const a = threeToIfcPlanResolved(northWing, inv, null, frame);
    const b = threeToIfcPlanResolved(southWing, inv, null, frame);
    assert.equal(a.elevation, 60);
    assert.equal(b.elevation, 60);
    assert.equal(a.y, 20);
    assert.equal(b.y, 70);
  });

  it("resolves a Z-up survey frame from the model probe", () => {
    const inv = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      219900, 907170, 59, 1,
    ];
    const modelBounds = { minX: -20, maxX: 20, minY: 0, maxY: 12, minZ: -20, maxZ: 20 };
    const footprints = { minX: 219880, maxX: 219920, minY: 907150, maxY: 907190 };
    assert.equal(resolveCoordAxisFrame(inv, modelBounds, footprints), "zup");
  });

  it("falls back to centre translation without a coordination matrix", () => {
    const footprints = { minX: 100, maxX: 110, minY: -20, maxY: 0 };
    const box = {
      minX: -5,
      maxX: 5,
      minY: 0,
      maxY: 3,
      minZ: 0,
      maxZ: 20,
    };
    const delta = planTranslationFromCentres(threeAabbCentre(box), footprints);
    const plan = threeToIfcPlanResolved({ x: 0, y: 1.5, z: 8 }, null, delta);
    assert.ok(Math.abs(plan.x - 105) < 1e-6);
    assert.ok(Math.abs(plan.y - -8) < 1e-6);
  });

  it("maps Three Y onto absolute IFC storey elevations after origin shift", () => {
    const box = {
      minX: -5,
      maxX: 5,
      minY: 0,
      maxY: 15,
      minZ: -5,
      maxZ: 5,
    };
    const elev = ifcElevationFromThree(3.45, box, [55.6768, 59.1312, 62.89]);
    assert.ok(Math.abs(elev - (3.45 + 55.6768)) < 1e-6);
  });

  it("lifts IFC plan to Three with Y-up flip and elevation offset", () => {
    const p = ifcPlanToThree(10, 3, 4.2, { heightOffsetM: 0.05 });
    assert.equal(p.x, 10);
    assert.equal(p.y, 4.25);
    assert.equal(p.z, -3);
  });

  it("lifts plan through coordination matrix inverse of camera undo", () => {
    const inv = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      100, 2, 50, 1,
    ];
    const forward = invertMat4(inv)!;
    assert.ok(forward);
    // Round-trip a camera Three point via plan lift.
    const three = { x: 1, y: 1.5, z: -3 };
    const plan = threeToIfcPlanResolved(three, inv, null);
    const back = ifcPlanToThree(plan.x, plan.y, plan.elevation, {
      coordInverse: inv,
    });
    assert.ok(Math.abs(back.x - three.x) < 1e-6);
    assert.ok(Math.abs(back.y - three.y) < 1e-6);
    assert.ok(Math.abs(back.z - three.z) < 1e-6);
    // Forward alone: origin shift
    const shifted = applyMat4Point({ x: 101, y: 3.5, z: 47 }, forward);
    assert.ok(Math.abs(shifted.x - 1) < 1e-6);
  });

  it("lifts polyline with centre-delta fallback and storey elev remap", () => {
    const box = {
      minX: -5,
      maxX: 5,
      minY: 0,
      maxY: 3,
      minZ: 0,
      maxZ: 20,
    };
    const footprints = { minX: 100, maxX: 110, minY: -20, maxY: 0 };
    const delta = planTranslationFromCentres(threeAabbCentre(box), footprints);
    const storeys = [55, 58];
    const pts = liftPlanPolylineToThree(
      [
        { x: 105, y: -8 },
        { x: 106, y: -8 },
      ],
      55,
      {
        centreDelta: delta,
        modelBounds: box,
        storeyElevationsM: storeys,
        heightOffsetM: 0.05,
      },
    );
    assert.equal(pts.length, 2);
    assert.ok(Math.abs(pts[0]!.y - threeYFromIfcElevation(55.05, box, storeys)) < 1e-6);
    // Round-trip XY through threeToIfcPlanResolved
    const plan = threeToIfcPlanResolved(pts[0]!, null, delta);
    assert.ok(Math.abs(plan.x - 105) < 1e-4);
    assert.ok(Math.abs(plan.y - -8) < 1e-4);
  });
});
