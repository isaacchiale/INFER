import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGeometricPath,
  continuousPolylineForStorey,
  localPathInPolygon,
  pathSegmentsForStorey,
  pointInPolygon,
  pointInSpace,
  polygonCentroid,
} from "./geometric-path.ts";
import type { FootprintsDocument } from "../types/footprints.ts";

const footprints: FootprintsDocument = {
  schema_version: "1.0",
  model_id: "t",
  coordinate_system: "ifc_world_xy_metres",
  storeys: [{ global_id: "S1", name: "L1", elevation: 0 }],
  spaces: [
    {
      global_id: "A",
      name: "Room A",
      storey_global_id: "S1",
      polygon: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      incomplete: false,
      method: "ifc_placement_bbox",
    },
    {
      global_id: "B",
      name: "Corridor B",
      storey_global_id: "S1",
      polygon: [
        { x: 10, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 10 },
        { x: 10, y: 10 },
      ],
      incomplete: false,
      method: "ifc_placement_bbox",
    },
    {
      global_id: "C",
      name: "Room C",
      storey_global_id: "S1",
      polygon: [
        { x: 30, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 10 },
        { x: 30, y: 10 },
      ],
      incomplete: false,
      method: "ifc_placement_bbox",
    },
  ],
  doors: [
    {
      global_id: "D1",
      name: "Door 1",
      storey_global_id: "S1",
      point: { x: 10, y: 5 },
      segment: [],
      incomplete: false,
      method: "ifc_object_placement",
    },
    {
      global_id: "D2",
      name: "Door 2",
      storey_global_id: "S1",
      point: { x: 30, y: 5 },
      segment: [],
      incomplete: false,
      method: "ifc_object_placement",
    },
  ],
  stairs: [
    {
      global_id: "ST",
      name: "Stair",
      storey_global_id: "S1",
      polygon: [
        { x: 18, y: 3 },
        { x: 22, y: 3 },
        { x: 22, y: 7 },
        { x: 18, y: 7 },
      ],
      incomplete: false,
      method: "ifc_placement_bbox",
    },
  ],
};

describe("geometric-path", () => {
  it("keeps local path inside polygon", () => {
    const poly = footprints.spaces[0]!.polygon;
    const path = localPathInPolygon({ x: 2, y: 2 }, { x: 8, y: 8 }, poly);
    assert.ok(path.length >= 2);
    assert.ok(pointInPolygon(path[0]!.x, path[0]!.y, poly));
  });

  it("treats holes as outside the space", () => {
    const exterior = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const hole = [
      { x: 3, y: 3 },
      { x: 7, y: 3 },
      { x: 7, y: 7 },
      { x: 3, y: 7 },
    ];
    assert.equal(pointInSpace(5, 5, exterior, [hole]), false);
    assert.equal(pointInSpace(1, 1, exterior, [hole]), true);
    const path = localPathInPolygon(
      { x: 1, y: 5 },
      { x: 9, y: 5 },
      exterior,
      [hole],
    );
    assert.ok(path.length >= 2);
    for (const p of path) {
      assert.ok(pointInSpace(p.x, p.y, exterior, [hole]), `point in hole: ${p.x},${p.y}`);
    }
  });

  it("biases corridor path away from the near wall (1/clearance cost)", () => {
    const corridor = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 4 },
      { x: 0, y: 4 },
    ];
    const path = localPathInPolygon(
      { x: 1, y: 0.3 },
      { x: 19, y: 0.3 },
      corridor,
    );
    assert.ok(path.length >= 2);
    const mid = path[Math.floor(path.length / 2)]!;
    assert.ok(
      mid.y > 1.2,
      `expected centre bias from 1/clearance, mid.y=${mid.y}`,
    );
  });

  it("builds space→door→space path", () => {
    const path = buildGeometricPath(["space:A", "door:D1", "space:B"], footprints);
    assert.equal(path.complete, true);
    assert.ok(path.segments.length >= 2);
    assert.ok(path.segments.every((s) => !s.incomplete && s.points.length >= 1));
    const onStorey = pathSegmentsForStorey(path, "S1");
    assert.ok(onStorey.length >= 1);
  });

  it("signals incomplete when footprint missing", () => {
    const path = buildGeometricPath(["space:A", "door:D1", "space:MISSING"], footprints);
    assert.equal(path.complete, false);
    assert.ok(path.segments.some((s) => s.incomplete));
  });

  it("skips intermediate space centroid: door→door through corridor", () => {
    const route = ["space:A", "door:D1", "space:B", "door:D2", "space:C"];
    const line = continuousPolylineForStorey(route, footprints, "S1");
    assert.equal(line.incomplete, false);
    assert.ok(line.points.length >= 2);
    // Waypoints = start + D1 + D2 + end (corridor B centroid omitted).
    assert.match(line.note, /4 waypoints/);

    const near = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(p.x - q.x, p.y - q.y) < 0.05;
    const d1 = footprints.doors[0]!.point!;
    const d2 = footprints.doors[1]!.point!;
    const aCent = polygonCentroid(footprints.spaces[0]!.polygon)!;
    const cCent = polygonCentroid(footprints.spaces[2]!.polygon)!;
    assert.ok(near(line.points[0]!, aCent), "starts at room A centroid");
    assert.ok(near(line.points[line.points.length - 1]!, cCent), "ends at room C centroid");
    assert.ok(line.points.some((p) => near(p, d1)), "includes door 1");
    assert.ok(line.points.some((p) => near(p, d2)), "includes door 2");
  });

  it("routes door→stair→door without intermediate space centroids", () => {
    const route = [
      "space:A",
      "door:D1",
      "space:B",
      "stair:ST",
      "space:B",
      "door:D2",
      "space:C",
    ];
    const line = continuousPolylineForStorey(route, footprints, "S1");
    assert.ok(line.points.length >= 2);
    // start + D1 + stair + D2 + end
    assert.match(line.note, /5 waypoints/);
    const stairCent = polygonCentroid(footprints.stairs![0]!.polygon)!;
    const near = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(p.x - q.x, p.y - q.y) < 0.05;
    assert.ok(line.points.some((p) => near(p, stairCent)), "includes stair portal");
  });

  it("projects door outside space to closest boundary point", () => {
    // Door mesh sits inside room A (like IFC); corridor B was inferred.
    const fp: FootprintsDocument = {
      ...footprints,
      doors: [
        {
          ...footprints.doors[0]!,
          point: { x: 9.7, y: 5 },
        },
        footprints.doors[1]!,
      ],
    };
    const path = buildGeometricPath(["space:A", "door:D1", "space:B"], fp);
    assert.equal(path.complete, true);
    // Second segment is door → corridor centroid (or portal→terminal).
    const corridorSeg = path.segments.find(
      (s) =>
        !s.incomplete &&
        s.points.length >= 2 &&
        Math.abs(s.points[0]!.x - 10) < 0.15,
    );
    assert.ok(corridorSeg, "corridor entry near x=10 boundary");
    const entry = corridorSeg!.points[0]!;
    assert.ok(Math.abs(entry.x - 10) < 0.05, `entry x≈10 got ${entry.x}`);
    assert.ok(Math.abs(entry.y - 5) < 0.15, `entry y≈5 got ${entry.y}`);
  });

  it("builds continuous polyline for storey", () => {
    const line = continuousPolylineForStorey(
      ["space:A", "door:D1", "space:B"],
      footprints,
      "S1",
    );
    assert.ok(line.points.length >= 2);
    assert.equal(line.incomplete, false);
  });
});
