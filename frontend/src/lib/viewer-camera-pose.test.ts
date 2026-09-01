import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyMat4Point,
  coordinatedToIfcPlan,
  ifcElevationFromThree,
  planTranslationFromCentres,
  pointInBuildingBounds,
  storeyIdForElevation,
  threeAabbCentre,
  threePositionToPlanPose,
  threeToIfcPlanResolved,
} from "./viewer-camera-pose.ts";

describe("viewer-camera-pose", () => {
  it("maps Three Y-up to IFC plan XY via web-ifc inverse", () => {
    const pose = threePositionToPlanPose({ x: 10, y: 4.2, z: -3 });
    assert.equal(pose.x, 10);
    assert.equal(pose.y, 3);
    assert.equal(pose.elevation, 4.2);
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
});
