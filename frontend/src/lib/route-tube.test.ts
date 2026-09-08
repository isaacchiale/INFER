import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildActiveStoreyRouteTubePoints,
  buildRouteTubePolylines,
  ROUTE_TUBE_HEIGHT_OFFSET_M,
} from "./route-tube.ts";
import type { FootprintsDocument } from "../types/footprints.ts";
import type { RouteResult } from "../types/graph.ts";

const footprints: FootprintsDocument = {
  schema_version: "1.0",
  model_id: "t",
  coordinate_system: "ifc_world_xy_metres",
  storeys: [{ global_id: "S1", name: "L1", elevation: 3 }],
  spaces: [
    {
      global_id: "A",
      name: "A",
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
      name: "B",
      storey_global_id: "S1",
      polygon: [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 10, y: 10 },
      ],
      incomplete: false,
      method: "ifc_placement_bbox",
    },
  ],
  doors: [
    {
      global_id: "D1",
      name: "D1",
      storey_global_id: "S1",
      point: { x: 10, y: 5 },
      segment: [],
      incomplete: false,
      method: "ifc_object_placement",
    },
  ],
};

const route: RouteResult = {
  found: true,
  origin_node_id: "space:A",
  destination_node_id: "space:B",
  node_ids: ["space:A", "door:D1", "space:B"],
  edge_ids: [],
  hops: 2,
  blocked_node_ids: [],
  blocked_edge_ids: [],
  message: "ok",
};

const localBounds = {
  minX: -5,
  maxX: 25,
  minY: 0,
  maxY: 5,
  minZ: -15,
  maxZ: 5,
};

describe("route-tube", () => {
  it("returns null without route or model bounds", () => {
    assert.equal(
      buildActiveStoreyRouteTubePoints({
        route: null,
        footprints,
        activeStoreyId: "S1",
        modelBounds: localBounds,
      }),
      null,
    );
    assert.equal(
      buildActiveStoreyRouteTubePoints({
        route,
        footprints,
        activeStoreyId: "S1",
      }),
      null,
    );
  });

  it("lifts with centre-delta for local and survey-scale footprints", () => {
    const local = buildActiveStoreyRouteTubePoints({
      route,
      footprints,
      activeStoreyId: "S1",
      modelBounds: localBounds,
    });
    assert.ok(local && local.length >= 2);
    assert.ok(Math.abs(local![0]!.y - ROUTE_TUBE_HEIGHT_OFFSET_M) < 1e-6);

    const ox = 219900;
    const oy = 907170;
    const geo: FootprintsDocument = {
      ...footprints,
      storeys: [{ global_id: "S1", name: "L1", elevation: 55.67 }],
      spaces: footprints.spaces.map((s) => ({
        ...s,
        polygon: s.polygon.map((p) => ({ x: p.x + ox, y: p.y + oy })),
      })),
      doors: footprints.doors.map((d) => ({
        ...d,
        point: d.point ? { x: d.point.x + ox, y: d.point.y + oy } : null,
      })),
    };
    const trapelo = buildActiveStoreyRouteTubePoints({
      route,
      footprints: geo,
      activeStoreyId: "S1",
      modelBounds: localBounds,
    });
    assert.ok(trapelo && trapelo.length >= 2);
    // Near model origin after centre-delta — not absolute survey XY.
    assert.ok(Math.abs(trapelo![0]!.x) < 100);
    assert.ok(Math.abs(trapelo![0]!.z) < 100);
  });

  it("prefers coordination matrix over centre-delta for survey IFCs", () => {
    const ox = 219900;
    const oy = 907170;
    const geo: FootprintsDocument = {
      ...footprints,
      storeys: [{ global_id: "S1", name: "L1", elevation: 55.67 }],
      spaces: footprints.spaces.map((s) => ({
        ...s,
        polygon: s.polygon.map((p) => ({ x: p.x + ox, y: p.y + oy })),
      })),
      doors: footprints.doors.map((d) => ({
        ...d,
        point: d.point ? { x: d.point.x + ox, y: d.point.y + oy } : null,
      })),
    };
    // Inverse of a pure origin shift (Fragments COORDINATE_TO_ORIGIN style).
    const coordInverse = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      ox, oy, 55.67, 1,
    ];
    const withMatrix = buildActiveStoreyRouteTubePoints({
      route,
      footprints: geo,
      activeStoreyId: "S1",
      modelBounds: localBounds,
      coordInverse,
    });
    assert.ok(withMatrix && withMatrix.length >= 2);
    // Must land near the model — not absolute survey XY.
    assert.ok(Math.abs(withMatrix![0]!.x) < 100);
    assert.ok(Math.abs(withMatrix![0]!.z) < 100);
  });

  it("falls back when matrix Z-up pack leaves survey coords far from mesh", () => {
    const ox = 219900;
    const oy = 907170;
    const geo: FootprintsDocument = {
      ...footprints,
      storeys: [{ global_id: "S1", name: "L1", elevation: 3 }],
      spaces: footprints.spaces.map((s) => ({
        ...s,
        polygon: s.polygon.map((p) => ({ x: p.x + ox, y: p.y + oy })),
      })),
      doors: footprints.doors.map((d) => ({
        ...d,
        point: d.point ? { x: d.point.x + ox, y: d.point.y + oy } : null,
      })),
    };
    // Identity "inverse" — Z-up pack keeps absolute survey metres (Trapelo vanish).
    const identity = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
    const pts = buildActiveStoreyRouteTubePoints({
      route,
      footprints: geo,
      activeStoreyId: "S1",
      modelBounds: localBounds,
      coordInverse: identity,
    });
    assert.ok(pts && pts.length >= 2);
    // Centre-delta (or Y-up pack) must win — near model, not ~2e5 m away.
    assert.ok(Math.abs(pts![0]!.x) < 100);
    assert.ok(Math.abs(pts![0]!.z) < 100);
  });

  it("uses the same placement for every route in a model", () => {
    const ox = 219900;
    const oy = 907170;
    const geo: FootprintsDocument = {
      ...footprints,
      storeys: [{ global_id: "S1", name: "L1", elevation: 55.67 }],
      spaces: footprints.spaces.map((s) => ({
        ...s,
        polygon: s.polygon.map((p) => ({ x: p.x + ox, y: p.y + oy })),
      })),
      doors: footprints.doors.map((d) => ({
        ...d,
        point: d.point ? { x: d.point.x + ox, y: d.point.y + oy } : null,
      })),
    };
    const coordInverse = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      ox, oy, 55.67, 1,
    ];
    const forward = buildActiveStoreyRouteTubePoints({
      route,
      footprints: geo,
      activeStoreyId: "S1",
      modelBounds: localBounds,
      coordInverse,
    });
    const reversed = buildActiveStoreyRouteTubePoints({
      route: {
        ...route,
        origin_node_id: "space:B",
        destination_node_id: "space:A",
        node_ids: [...route.node_ids].reverse(),
      },
      footprints: geo,
      activeStoreyId: "S1",
      modelBounds: localBounds,
      coordInverse,
    });
    assert.ok(forward && reversed);
    // Same mapping ⇒ reversing the route only reverses the points.
    const a = forward![0]!;
    const b = reversed![reversed!.length - 1]!;
    assert.ok(Math.abs(a.x - b.x) < 1e-6);
    assert.ok(Math.abs(a.y - b.y) < 1e-6);
    assert.ok(Math.abs(a.z - b.z) < 1e-6);
  });

  it("picks a storey when activeStoreyId is all", () => {
    const pts = buildActiveStoreyRouteTubePoints({
      route,
      footprints,
      activeStoreyId: "all",
      modelBounds: localBounds,
    });
    assert.ok(pts && pts.length >= 2);
  });

  it("builds a tube polyline for every storey on the route", () => {
    const multi: FootprintsDocument = {
      ...footprints,
      storeys: [
        { global_id: "S1", name: "L1", elevation: 0 },
        { global_id: "S2", name: "L2", elevation: 3.5 },
      ],
      spaces: [
        ...footprints.spaces,
        {
          global_id: "C",
          name: "C",
          storey_global_id: "S2",
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
          global_id: "D",
          name: "D",
          storey_global_id: "S2",
          polygon: [
            { x: 10, y: 0 },
            { x: 20, y: 0 },
            { x: 20, y: 10 },
            { x: 10, y: 10 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
      ],
      doors: [
        ...footprints.doors,
        {
          global_id: "D2",
          name: "D2",
          storey_global_id: "S2",
          point: { x: 10, y: 5 },
          segment: [],
          incomplete: false,
          method: "ifc_object_placement",
        },
      ],
      stairs: [
        {
          global_id: "ST1",
          name: "Stair",
          storey_global_id: "S1",
          polygon: [
            { x: 4, y: 4 },
            { x: 6, y: 4 },
            { x: 6, y: 6 },
            { x: 4, y: 6 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
      ],
    };
    // Same-building route that only has geometry on S1 — still one polyline.
    const one = buildRouteTubePolylines({
      route,
      footprints: multi,
      modelBounds: localBounds,
    });
    assert.ok(one);
    assert.equal(one!.length, 1);

    const routeL2: RouteResult = {
      ...route,
      origin_node_id: "space:C",
      destination_node_id: "space:D",
      node_ids: ["space:C", "door:D2", "space:D"],
    };
    // Two independent single-storey routes → when combined via one route that
    // visits both floors through a stair, we get two storey slices.
    const crossFloor: RouteResult = {
      found: true,
      origin_node_id: "space:A",
      destination_node_id: "space:D",
      node_ids: [
        "space:A",
        "door:D1",
        "space:B",
        "stair:ST1",
        "space:C",
        "door:D2",
        "space:D",
      ],
      edge_ids: [],
      hops: 6,
      blocked_node_ids: [],
      blocked_edge_ids: [],
      message: "ok",
    };
    const both = buildRouteTubePolylines({
      route: crossFloor,
      footprints: multi,
      modelBounds: {
        ...localBounds,
        maxY: 8,
      },
    });
    assert.ok(both);
    assert.ok(both!.length >= 2, `expected ≥2 storey tubes, got ${both!.length}`);
    // Different elevations (S1 ≈ 0.7, S2 ≈ 4.2 with height offset).
    const y0 = both![0]![0]!.y;
    const y1 = both![1]![0]!.y;
    assert.ok(Math.abs(y0 - y1) > 2, `expected distinct floors, y=${y0},${y1}`);
    void routeL2;
  });

  it("lifts Nordic-style survey elevations onto the mesh (not mm crush)", () => {
    // Sea Level at 0 has no spaces; building starts at Foundations ≈ 51 m.
    // After COORDINATE_TO_ORIGIN the mesh floor is near Y=0, so Level_01 (55.5)
    // must land near Y≈4.5+ε — not ~0.08 (false mm) or ~55 (sea-level datum).
    const nordic: FootprintsDocument = {
      ...footprints,
      storeys: [
        { global_id: "sea", name: "Sea Level", elevation: 0 },
        { global_id: "found", name: "Foundations", elevation: 51 },
        { global_id: "S1", name: "Level_01", elevation: 55.5 },
      ],
      spaces: [
        {
          global_id: "F0",
          name: "Foundation void",
          storey_global_id: "found",
          polygon: [
            { x: 0, y: 0 },
            { x: 2, y: 0 },
            { x: 2, y: 2 },
            { x: 0, y: 2 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
        ...footprints.spaces.map((s) => ({
          ...s,
          storey_global_id: "S1",
        })),
      ],
    };
    const meshBounds = {
      minX: -20,
      maxX: 20,
      minY: 0,
      maxY: 30,
      minZ: -20,
      maxZ: 20,
    };
    const pts = buildActiveStoreyRouteTubePoints({
      route,
      footprints: nordic,
      activeStoreyId: "S1",
      modelBounds: meshBounds,
    });
    assert.ok(pts && pts.length >= 2);
    const y = pts![0]!.y;
    assert.ok(
      y > 3 && y < 8,
      `expected Level_01 near mesh (~4.5+0.7), got y=${y}`,
    );
  });
});
