import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGeometricPath,
  continuousPolylineForStorey,
  localPathInPolygon,
  pathSegmentsForStorey,
  pointInPolygon,
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
      name: "Room B",
      storey_global_id: "S1",
      polygon: [
        { x: 12, y: 0 },
        { x: 22, y: 0 },
        { x: 22, y: 10 },
        { x: 12, y: 10 },
      ],
      incomplete: false,
      method: "ifc_placement_bbox",
    },
  ],
  doors: [
    {
      global_id: "D",
      name: "Door",
      storey_global_id: "S1",
      point: { x: 10, y: 5 },
      segment: [],
      incomplete: false,
      method: "ifc_object_placement",
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

  it("builds space→door→space path", () => {
    const path = buildGeometricPath(["space:A", "door:D", "space:B"], footprints);
    assert.equal(path.complete, true);
    assert.ok(path.segments.length >= 2);
    assert.ok(path.segments.every((s) => !s.incomplete && s.points.length >= 1));
    const onStorey = pathSegmentsForStorey(path, "S1");
    assert.ok(onStorey.length >= 1);
  });

  it("signals incomplete when footprint missing", () => {
    const path = buildGeometricPath(["space:A", "door:D", "space:MISSING"], footprints);
    assert.equal(path.complete, false);
    assert.ok(path.segments.some((s) => s.incomplete));
  });

  it("builds continuous polyline for storey", () => {
    const line = continuousPolylineForStorey(
      ["space:A", "door:D", "space:B"],
      footprints,
      "S1",
    );
    assert.ok(line.points.length >= 2);
    assert.equal(line.incomplete, false);
  });
});
