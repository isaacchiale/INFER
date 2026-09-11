import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGeometricPath,
  continuousPolylineForStorey,
  doorwayVoidsInSpace,
  furnitureOverlappingSpace,
  localPathInPolygon,
  pathSegmentsForStorey,
  pointInPolygon,
  pointInSpace,
  polygonCentroid,
  wallsOverlappingSpace,
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

  it("routes around interior IfcWall obstacles inside a space", () => {
    // Room 20×10 with a vertical interior wall; only a bottom gap is clear.
    const exterior = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ];
    const wall = [
      { x: 9.7, y: 2 },
      { x: 10.3, y: 2 },
      { x: 10.3, y: 9.5 },
      { x: 9.7, y: 9.5 },
    ];
    const path = localPathInPolygon(
      { x: 2, y: 5 },
      { x: 18, y: 5 },
      exterior,
      undefined,
      [wall],
    );
    assert.ok(path.length >= 2);
    for (const p of path) {
      assert.ok(
        pointInSpace(p.x, p.y, exterior),
        `path left space at ${p.x},${p.y}`,
      );
      assert.ok(
        !pointInPolygon(p.x, p.y, wall),
        `path cut through wall at ${p.x},${p.y}`,
      );
    }
    // Must duck through the bottom gap (y < 2).
    assert.ok(
      path.some((p) => p.x > 9.5 && p.x < 10.5 && p.y < 2),
      "expected path through bottom gap around interior wall",
    );
  });

  it("does not diagonally corner-cut a thin wall", () => {
    const exterior = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    // Single-cell-thick wall with a one-cell gap at the bottom — diagonal
    // A* would otherwise clip the lower corner of the wall.
    const wall = [
      { x: 4.95, y: 0.15 },
      { x: 5.05, y: 0.15 },
      { x: 5.05, y: 9.5 },
      { x: 4.95, y: 9.5 },
    ];
    const path = localPathInPolygon(
      { x: 1, y: 5 },
      { x: 9, y: 5 },
      exterior,
      undefined,
      [wall],
    );
    assert.ok(path.length >= 2);
    for (const p of path) {
      assert.ok(
        !pointInPolygon(p.x, p.y, wall),
        `diagonal cut through wall at ${p.x},${p.y}`,
      );
    }
  });

  it("wallsOverlappingSpace picks same-storey walls that intersect the room", () => {
    const space = footprints.spaces[1]!; // corridor B
    const fp: FootprintsDocument = {
      ...footprints,
      walls: [
        {
          global_id: "W-in",
          name: "Interior",
          storey_global_id: "S1",
          polygon: [
            { x: 15, y: 2 },
            { x: 16, y: 2 },
            { x: 16, y: 8 },
            { x: 15, y: 8 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
        {
          global_id: "W-other-floor",
          name: "Other",
          storey_global_id: "S2",
          polygon: [
            { x: 15, y: 2 },
            { x: 16, y: 2 },
            { x: 16, y: 8 },
            { x: 15, y: 8 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
        {
          global_id: "W-outside",
          name: "Outside",
          storey_global_id: "S1",
          polygon: [
            { x: 100, y: 0 },
            { x: 101, y: 0 },
            { x: 101, y: 1 },
            { x: 100, y: 1 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
      ],
    };
    const obs = wallsOverlappingSpace(fp, space);
    assert.equal(obs.length, 1);
    assert.equal(obs[0]![0]!.x, 15);
  });

  it("furnitureOverlappingSpace picks same-storey furniture that intersects the room", () => {
    const space = footprints.spaces[1]!; // corridor B
    const fp: FootprintsDocument = {
      ...footprints,
      furniture: [
        {
          global_id: "F-in",
          name: "Desk",
          storey_global_id: "S1",
          polygon: [
            { x: 15, y: 2 },
            { x: 16, y: 2 },
            { x: 16, y: 8 },
            { x: 15, y: 8 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
        {
          global_id: "F-other-floor",
          name: "Other",
          storey_global_id: "S2",
          polygon: [
            { x: 15, y: 2 },
            { x: 16, y: 2 },
            { x: 16, y: 8 },
            { x: 15, y: 8 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
        {
          global_id: "F-outside",
          name: "Outside",
          storey_global_id: "S1",
          polygon: [
            { x: 100, y: 0 },
            { x: 101, y: 0 },
            { x: 101, y: 1 },
            { x: 100, y: 1 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
      ],
    };
    const obs = furnitureOverlappingSpace(fp, space);
    assert.equal(obs.length, 1);
    assert.equal(obs[0]![0]!.x, 15);
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

  it("routes space↔space heals through openings like doors", () => {
    const fp: FootprintsDocument = {
      ...footprints,
      openings: [
        {
          global_id: "O_AB",
          name: "Opening AB",
          storey_global_id: "S1",
          point: { x: 10, y: 5 },
          segment: [],
          incomplete: false,
          method: "ifc_object_placement",
        },
        {
          global_id: "O_BC",
          name: "Opening BC",
          storey_global_id: "S1",
          point: { x: 30, y: 5 },
          segment: [],
          incomplete: false,
          method: "ifc_object_placement",
        },
      ],
    };
    const graph = {
      schema_version: "1.0" as const,
      model_id: "t",
      nodes: [],
      edges: [
        {
          id: "e1",
          kind: "space_space" as const,
          source: "space:A",
          target: "space:B",
          global_id: "O_AB",
          method: "geom_opening_space" as const,
          inferred: true,
          portal: { x: 10, y: 5 },
        },
        {
          id: "e2",
          kind: "space_space" as const,
          source: "space:B",
          target: "space:C",
          global_id: "O_BC",
          method: "geom_opening_space" as const,
          inferred: true,
          portal: { x: 30, y: 5 },
        },
      ],
    };

    const route = ["space:A", "space:B", "space:C"];
    const line = continuousPolylineForStorey(route, fp, "S1", graph);
    assert.equal(line.incomplete, false);
    // start + opening AB + opening BC + end
    assert.match(line.note, /4 waypoints/);

    const near = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(p.x - q.x, p.y - q.y) < 0.05;
    const aCent = polygonCentroid(fp.spaces[0]!.polygon)!;
    const cCent = polygonCentroid(fp.spaces[2]!.polygon)!;
    const oAb = { x: 10, y: 5 };
    const oBc = { x: 30, y: 5 };

    assert.ok(near(line.points[0]!, aCent), "starts at room A centroid");
    assert.ok(near(line.points[line.points.length - 1]!, cCent), "ends at C");
    assert.ok(line.points.some((p) => near(p, oAb)), "passes opening AB");
    assert.ok(line.points.some((p) => near(p, oBc)), "passes opening BC");

    // Must not be a single straight centroid–centroid chord (would skip openings).
    const isStraightChord =
      line.points.length === 2 &&
      near(line.points[0]!, aCent) &&
      near(line.points[1]!, cCent);
    assert.equal(isStraightChord, false);

    const path = buildGeometricPath(route, fp, graph);
    assert.equal(path.complete, true);
    assert.ok(path.segments.length >= 3);
    assert.ok(path.segments.every((s) => !s.incomplete && s.points.length >= 1));
  });

  it("prefers edge clear-span portal over facade openings", () => {
    const fp: FootprintsDocument = {
      ...footprints,
      openings: [
        {
          global_id: "FACADE",
          name: "Facade window",
          storey_global_id: "S1",
          point: { x: 5, y: 0 },
          segment: [],
          incomplete: false,
          method: "ifc_object_placement",
        },
      ],
    };
    const graph = {
      schema_version: "1.0" as const,
      model_id: "t",
      nodes: [],
      edges: [
        {
          id: "e1",
          kind: "space_space" as const,
          source: "space:A",
          target: "space:B",
          method: "geom_opening_space" as const,
          inferred: true,
          portal: { x: 10, y: 5 },
        },
      ],
    };
    const line = continuousPolylineForStorey(
      ["space:A", "space:B"],
      fp,
      "S1",
      graph,
    );
    const near = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(p.x - q.x, p.y - q.y) < 0.05;
    assert.ok(
      line.points.some((p) => near(p, { x: 10, y: 5 })),
      "uses strip portal on shared wall",
    );
    assert.ok(
      !line.points.some((p) => near(p, { x: 5, y: 0 })),
      "ignores facade opening",
    );
  });

  it("A* through L-shaped room for door↔space–space in both directions", () => {
    // A (left) --door-- B (L) --heal-- C (top). Forward used to chord door→portal.
    const fp: FootprintsDocument = {
      model_id: "t",
      storeys: [{ global_id: "S1", name: "S1", elevation: 0 }],
      spaces: [
        {
          global_id: "A",
          name: "A",
          storey_global_id: "S1",
          polygon: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 4 },
            { x: 0, y: 4 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
        {
          global_id: "B",
          name: "B",
          storey_global_id: "S1",
          polygon: [
            { x: 4, y: 0 },
            { x: 12, y: 0 },
            { x: 12, y: 10 },
            { x: 8, y: 10 },
            { x: 8, y: 4 },
            { x: 4, y: 4 },
          ],
          incomplete: false,
          method: "ifc_mesh_xy_outline",
        },
        {
          global_id: "C",
          name: "C",
          storey_global_id: "S1",
          polygon: [
            { x: 8, y: 10 },
            { x: 12, y: 10 },
            { x: 12, y: 14 },
            { x: 8, y: 14 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
      ],
      doors: [
        {
          global_id: "D_AB",
          name: "D_AB",
          storey_global_id: "S1",
          point: { x: 4, y: 2 },
          incomplete: false,
          method: "ifc_object_placement",
        },
      ],
      openings: [],
      stairs: [],
      walls: [],
    };
    const graph = {
      schema_version: "1.0" as const,
      model_id: "t",
      nodes: [],
      edges: [
        {
          id: "e_bc",
          kind: "space_space" as const,
          source: "space:B",
          target: "space:C",
          method: "geom_opening_space" as const,
          inferred: true,
          portal: { x: 10, y: 10 },
        },
      ],
    };

    const inB = (p: { x: number; y: number }) =>
      pointInSpace(p.x, p.y, fp.spaces[1]!.polygon) ||
      Math.hypot(p.x - 10, p.y - 10) < 0.15 ||
      Math.hypot(p.x - 4, p.y - 2) < 0.15;
    /** Chord door→portal crosses the L notch (outside B). */
    const cutsNotch = (points: { x: number; y: number }[]) => {
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!;
        const b = points[i + 1]!;
        // Only flag long chords — A* steps are ~0.1 m.
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1) continue;
        for (const t of [0.25, 0.5, 0.75]) {
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          if (x >= 4 && x < 8 && y > 4 && y < 10) return true;
        }
      }
      return false;
    };

    for (const route of [
      ["space:A", "door:D_AB", "space:B", "space:C"],
      ["space:C", "space:B", "door:D_AB", "space:A"],
    ]) {
      const line = continuousPolylineForStorey(route, fp, "S1", graph);
      assert.equal(line.incomplete, false, `incomplete for ${route.join(">")}`);
      assert.ok(line.points.length > 4, `expected A* density for ${route.join(">")}`);
      assert.equal(
        cutsNotch(line.points),
        false,
        `chord cut L-notch for ${route.join(">")}`,
      );
      for (const p of line.points) {
        if (p.x < 4 || p.x > 12 || p.y < 0 || p.y > 10) continue; // A or C
        assert.ok(inB(p), `left B at ${p.x},${p.y} on ${route.join(">")}`);
      }

      const path = buildGeometricPath(route, fp, graph);
      assert.equal(path.complete, true, `buildGeometricPath ${route.join(">")}`);
      assert.ok(
        path.segments.some((s) => s.points.length > 2),
        `expected A* segment for ${route.join(">")}`,
      );
    }
  });

  /**
   * Room 10×10 split across the middle by one of its own walls, with a 0.9 m
   * doorway in it. The wall footprint is a solid hull that fills that doorway
   * in, so without carving A* is stranded and the overlay draws a chord.
   */
  const severedRoom = (opening: Record<string, unknown> | null): FootprintsDocument => ({
    schema_version: "1.0",
    model_id: "t",
    coordinate_system: "ifc_world_xy_metres",
    storeys: [{ global_id: "S1", name: "L1", elevation: 0 }],
    spaces: [
      {
        global_id: "R",
        name: "R",
        storey_global_id: "S1",
        polygon: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        incomplete: false,
        method: "ifc_mesh_xy_outline",
      },
    ],
    doors: [
      {
        global_id: "D_IN",
        name: "In",
        storey_global_id: "S1",
        point: { x: 0, y: 2 },
        segment: [],
        incomplete: false,
        method: "ifc_object_placement",
      },
      {
        global_id: "D_OUT",
        name: "Out",
        storey_global_id: "S1",
        point: { x: 0, y: 8 },
        segment: [],
        incomplete: false,
        method: "ifc_object_placement",
      },
    ],
    stairs: [],
    walls: [
      {
        global_id: "W",
        name: "Divider",
        storey_global_id: "S1",
        polygon: [
          { x: 0, y: 4.94 },
          { x: 10, y: 4.94 },
          { x: 10, y: 5.06 },
          { x: 0, y: 5.06 },
        ],
        incomplete: false,
        method: "ifc_mesh_xy_hull",
      },
    ],
    openings: opening ? [opening] : [],
  } as unknown as FootprintsDocument);

  const doorwayOpening = {
    global_id: "O_DOOR",
    name: "Doorway",
    storey_global_id: "S1",
    point: { x: 6.5, y: 5 },
    segment: [],
    incomplete: false,
    method: "ifc_mesh_xy_centroid",
    filled_by_door_global_id: "D_MID",
    filled_by_window_global_id: null,
    host_global_id: "W",
    host_is_wall: true,
    polygon: [
      { x: 6.05, y: 4.94 },
      { x: 6.95, y: 4.94 },
      { x: 6.95, y: 5.06 },
      { x: 6.05, y: 5.06 },
    ],
    sill_z: 0,
    head_z: 2.03,
  };

  it("doorwayVoidsInSpace keeps wall doorways and drops furniture recesses", () => {
    const fp = severedRoom(doorwayOpening);
    assert.equal(doorwayVoidsInSpace(fp, fp.spaces[0]!).length, 1);

    // Same void, but it recesses a cabinet rather than a wall.
    const furniture = severedRoom({ ...doorwayOpening, host_is_wall: false });
    assert.equal(doorwayVoidsInSpace(furniture, furniture.spaces[0]!).length, 0);

    // Wall-profile void: large on both plan axes, so not a doorway.
    const wallProfile = severedRoom({
      ...doorwayOpening,
      polygon: [
        { x: 1, y: 1 },
        { x: 9, y: 1 },
        { x: 9, y: 9 },
        { x: 1, y: 9 },
      ],
    });
    assert.equal(doorwayVoidsInSpace(wallProfile, wallProfile.spaces[0]!).length, 0);
  });

  it("walks the doorway when a wall hull severs a room in two", () => {
    const fp = severedRoom(doorwayOpening);
    const line = continuousPolylineForStorey(
      ["space:R", "door:D_IN", "space:R", "door:D_OUT"],
      fp,
      "S1",
    );
    // A* still has to bend around the divider and through the doorway; string-pulling
    // now collapses that into a few straight segments instead of a dense cell walk, but
    // a literal 2-point chord (the `reached: false` fallback) would mean it gave up.
    assert.ok(line.points.length > 2, "expected a routed path, not a straight chord");

    const crossings = [];
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1]!;
      const b = line.points[i]!;
      if (a.y > 5 === b.y > 5) continue;
      crossings.push(a.x + ((5 - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    assert.ok(crossings.length > 0, "path never crossed the divider");
    for (const x of crossings) {
      assert.ok(x > 6 && x < 7, `crossed the wall at x=${x}, not via the doorway`);
    }
  });

  it("stays inside the space when a sealed wall leaves A* nowhere to go", () => {
    // No opening at all: the divider is solid. The overlay must not answer with
    // a straight chord that leaves the room.
    const fp = severedRoom(null);
    const line = continuousPolylineForStorey(
      ["space:R", "door:D_IN", "space:R", "door:D_OUT"],
      fp,
      "S1",
    );
    // Same reasoning as the doorway test above: string-pulling shortens the raw
    // grid walk, but it must still be more than the bare 2-point failure fallback.
    assert.ok(line.points.length > 2, "expected a routed path, not a straight chord");
    for (const p of line.points) {
      assert.ok(
        pointInSpace(p.x, p.y, fp.spaces[0]!.polygon),
        `path left the space at ${p.x},${p.y}`,
      );
    }
  });
});
