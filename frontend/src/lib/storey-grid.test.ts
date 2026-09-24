import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAllStoreyNavmeshes, buildStoreyNavmesh } from "./navmesh.ts";
import {
  buildStoreyGrid,
  buildStoreyGrids,
  findGridMultiStoreyPath,
  findGridNearestExitPath,
  findGridPath,
} from "./storey-grid.ts";
import { pointInPolygon } from "./geometric-path.ts";
import type { ConnectivityGraph } from "../types/graph.ts";
import type { FootprintsDocument, Point2D } from "../types/footprints.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): Point2D[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const space = (id: string, polygon: Point2D[], storey = "S1") => ({
  global_id: id,
  name: id,
  storey_global_id: storey,
  polygon,
  incomplete: false,
  method: "ifc_placement_bbox" as const,
});

const door = (id: string, point: Point2D, segment: Point2D[]) => ({
  global_id: id,
  name: id,
  storey_global_id: "S1",
  point,
  segment,
  incomplete: false,
  method: "ifc_object_placement" as const,
});

const doorEdges = (doorId: string, spaces: string[]) =>
  spaces.map((s) => ({
    id: `sd:${s}:${doorId}`,
    kind: "space_door" as const,
    source: `space:${s}`,
    target: `door:${doorId}`,
    method: "ifc_rel_space_boundary" as const,
    inferred: false,
  }));

/** Rooms A (0–4) and B (4–8) touching along x=4, one door at (4,2). */
const footprints: FootprintsDocument = {
  schema_version: "1.0",
  model_id: "t",
  coordinate_system: "ifc_world_xy_metres",
  storeys: [{ global_id: "S1", name: "L1", elevation: 0 }],
  spaces: [space("A", rect(0, 0, 4, 4)), space("B", rect(4, 0, 8, 4))],
  doors: [door("D", { x: 4, y: 2 }, [{ x: 4, y: 1.5 }, { x: 4, y: 2.5 }])],
};

const graph: ConnectivityGraph = {
  schema_version: "1.0",
  model_id: "t",
  variant: "geometry",
  nodes: [
    { id: "space:A", kind: "space", global_id: "A", name: "A", storey_global_id: "S1" },
    { id: "space:B", kind: "space", global_id: "B", name: "B", storey_global_id: "S1" },
    { id: "door:D", kind: "door", global_id: "D", name: "D", storey_global_id: "S1" },
  ],
  edges: doorEdges("D", ["A", "B"]),
};

function setup(fp: FootprintsDocument, g: ConnectivityGraph, opts: Parameters<typeof buildStoreyNavmesh>[3] = {}) {
  const mesh = buildStoreyNavmesh(fp, g, "S1", opts);
  return { mesh, grid: buildStoreyGrid(mesh, fp) };
}

describe("storey grid routing", () => {
  it("routes inside one room", () => {
    const { mesh, grid } = setup(footprints, graph);
    const path = findGridPath(grid, mesh, { x: 1, y: 1 }, { x: 3, y: 3 });
    assert.equal(path.found, true);
    assert.deepEqual(path.points[0], { x: 1, y: 1 });
    assert.deepEqual(path.points[path.points.length - 1], { x: 3, y: 3 });
    assert.deepEqual(path.graphNodeIds, ["space:A"]);
  });

  it("crosses between rooms only through the door", () => {
    const { mesh, grid } = setup(footprints, graph);
    const path = findGridPath(grid, mesh, { x: 1, y: 0.5 }, { x: 7, y: 0.5 });
    assert.equal(path.found, true);
    assert.deepEqual(path.graphNodeIds, ["space:A", "space:B"]);
    // Pins sit at y=0.5 but the only opening spans y 1.5–2.5, so the route must climb to it.
    const crossing = path.points.findIndex((p, i) => i > 0 && path.points[i - 1]!.x < 4 && p.x >= 4);
    assert.ok(crossing > 0, "expected the path to cross x=4");
    const a = path.points[crossing - 1]!;
    const b = path.points[crossing]!;
    const yAtWall = a.y + ((4 - a.x) / (b.x - a.x)) * (b.y - a.y);
    assert.ok(yAtWall > 1.3 && yAtWall < 2.7, `crossed x=4 at y=${yAtWall.toFixed(2)}, outside the door`);
  });

  it("does not leak between touching rooms once their door is excluded", () => {
    const { mesh, grid } = setup(footprints, graph, {
      excludedEdgeIds: new Set(["viz-door:door:D:space:A:space:B"]),
    });
    const path = findGridPath(grid, mesh, { x: 1, y: 2 }, { x: 7, y: 2 });
    assert.equal(path.found, false);
  });

  it("closes a blocked door for that search only", () => {
    const { mesh, grid } = setup(footprints, graph);
    const blocked = findGridPath(grid, mesh, { x: 1, y: 2 }, { x: 7, y: 2 }, {
      blockedPortalIds: new Set([mesh.portals[0]!.id]),
    });
    assert.equal(blocked.found, false);
    assert.equal(findGridPath(grid, mesh, { x: 1, y: 2 }, { x: 7, y: 2 }).found, true);
  });

  it("walks through a door carved in a real wall gap", () => {
    const fp: FootprintsDocument = {
      ...footprints,
      spaces: [space("A", rect(0, 0, 4, 4)), space("B", rect(4.3, 0, 8, 4))],
      doors: [door("D", { x: 4.15, y: 2 }, [{ x: 4.15, y: 1.5 }, { x: 4.15, y: 2.5 }])],
      walls: [
        {
          global_id: "W",
          name: "W",
          storey_global_id: "S1",
          polygon: rect(4, -0.2, 4.3, 4.2),
          incomplete: false,
          method: "ifc_mesh_xy_hull",
        },
      ],
    };
    const { mesh, grid } = setup(fp, graph);
    const path = findGridPath(grid, mesh, { x: 1, y: 3.5 }, { x: 7, y: 3.5 });
    assert.equal(path.found, true);
    assert.deepEqual(path.graphNodeIds, ["space:A", "space:B"]);
    for (const p of path.points) {
      if (p.x > 4 && p.x < 4.3) assert.ok(Math.abs(p.y - 2) < 0.6, `went through the wall at y=${p.y}`);
    }
  });

  it("lets every room pair through a door shared by three rooms", () => {
    const fp: FootprintsDocument = {
      ...footprints,
      spaces: [space("A", rect(0, 0, 4, 4)), space("B", rect(4, 0, 8, 4)), space("C", rect(0, 4, 8, 6))],
      doors: [door("D", { x: 4, y: 4 }, [{ x: 3.5, y: 4 }, { x: 4.5, y: 4 }])],
    };
    const g: ConnectivityGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: "space:C", kind: "space", global_id: "C", name: "C", storey_global_id: "S1" },
      ],
      edges: doorEdges("D", ["A", "B", "C"]),
    };
    const { mesh, grid } = setup(fp, g);
    assert.equal(mesh.portals.length, 3);
    for (const [from, to] of [
      [{ x: 1, y: 1 }, { x: 7, y: 1 }],
      [{ x: 1, y: 1 }, { x: 1, y: 5 }],
      [{ x: 7, y: 1 }, { x: 7, y: 5 }],
    ] as const) {
      assert.equal(findGridPath(grid, mesh, from, to).found, true, `${JSON.stringify(from)} → ${JSON.stringify(to)}`);
    }
  });

  it("routes around furniture", () => {
    const desk = {
      global_id: "Desk",
      name: "Desk",
      storey_global_id: "S1",
      polygon: rect(1.8, 0.5, 2.2, 3.5),
      incomplete: false,
      method: "ifc_placement_bbox" as const,
    };
    const fp: FootprintsDocument = { ...footprints, furniture: [desk] };
    const { mesh, grid } = setup(fp, graph);
    const path = findGridPath(grid, mesh, { x: 0.5, y: 2 }, { x: 3.5, y: 2 });
    assert.equal(path.found, true);
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1]!;
      const b = path.points[i]!;
      for (let t = 0; t <= 1; t += 0.02) {
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        assert.ok(!pointInPolygon(x, y, desk.polygon), `path cut through the desk at ${x},${y}`);
      }
    }
  });

  it("stays in the hall instead of cutting through a furnished room", () => {
    const fp: FootprintsDocument = {
      ...footprints,
      spaces: [space("Hall", rect(0, 0, 10, 2)), space("Room", rect(0, 2, 10, 6))],
      doors: [
        door("W", { x: 1, y: 2 }, [{ x: 0.5, y: 2 }, { x: 1.5, y: 2 }]),
        door("E", { x: 9, y: 2 }, [{ x: 8.5, y: 2 }, { x: 9.5, y: 2 }]),
      ],
      furniture: [
        {
          global_id: "Desk",
          name: "Desk",
          storey_global_id: "S1",
          polygon: rect(3, 3, 7, 5),
          incomplete: false,
          method: "ifc_placement_bbox",
        },
      ],
    };
    const g: ConnectivityGraph = {
      ...graph,
      nodes: [
        { id: "space:Hall", kind: "space", global_id: "Hall", name: "Hall", storey_global_id: "S1" },
        { id: "space:Room", kind: "space", global_id: "Room", name: "Room", storey_global_id: "S1" },
        { id: "door:W", kind: "door", global_id: "W", name: "W", storey_global_id: "S1" },
        { id: "door:E", kind: "door", global_id: "E", name: "E", storey_global_id: "S1" },
      ],
      edges: [...doorEdges("W", ["Hall", "Room"]), ...doorEdges("E", ["Hall", "Room"])],
    };
    const { mesh, grid } = setup(fp, g);
    const path = findGridPath(grid, mesh, { x: 1, y: 1 }, { x: 9, y: 1 });
    assert.equal(path.found, true);
    assert.ok(path.points.every((p) => p.y <= 2.05), "expected a hall-only route");
    assert.deepEqual(path.graphNodeIds, ["space:Hall"]);
  });

  describe("exits", () => {
    const fp: FootprintsDocument = {
      ...footprints,
      doors: [...footprints.doors, door("E", { x: 0, y: 2 }, [{ x: 0, y: 1.5 }, { x: 0, y: 2.5 }])],
    };
    const g: ConnectivityGraph = {
      ...graph,
      nodes: [...graph.nodes, { id: "door:E", kind: "door", global_id: "E", name: "E", storey_global_id: "S1" }],
      edges: [...graph.edges, ...doorEdges("E", ["A"])],
    };

    it("routes to the nearest exit", () => {
      const { mesh, grid } = setup(fp, g);
      const result = findGridNearestExitPath(grid, mesh, { x: 6, y: 2 });
      assert.equal(result.found, true);
      assert.equal(result.exitPortalId, "viz-exit:door:E:space:A");
      assert.deepEqual(result.points[result.points.length - 1], { x: 0, y: 2 });
      assert.deepEqual(result.graphNodeIds, ["space:B", "space:A"]);
    });

    it("reports no reachable exit when the connecting door is blocked", () => {
      const { mesh, grid } = setup(fp, g);
      const doorId = mesh.portals.find((p) => p.kind === "door")!.id;
      const result = findGridNearestExitPath(grid, mesh, { x: 6, y: 2 }, {
        blockedPortalIds: new Set([doorId]),
      });
      assert.equal(result.found, false);
    });
  });

  describe("across storeys", () => {
    const fp: FootprintsDocument = {
      ...footprints,
      storeys: [
        { global_id: "S1", name: "L1", elevation: 0 },
        { global_id: "S2", name: "L2", elevation: 3 },
      ],
      spaces: [...footprints.spaces, space("C", rect(0, 0, 4, 4), "S2")],
    };
    const g: ConnectivityGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: "space:C", kind: "space", global_id: "C", name: "C", storey_global_id: "S2" },
        { id: "stair:ST", kind: "stair", global_id: "ST", name: "Stair", storey_global_id: "S1" },
      ],
      edges: [
        ...graph.edges,
        { id: "v:A", kind: "vertical", source: "space:A", target: "stair:ST", method: "geom_stair_space", inferred: true },
        { id: "v:C", kind: "vertical", source: "space:C", target: "stair:ST", method: "geom_stair_space", inferred: true },
      ],
    };

    it("routes through a shared stair", () => {
      const meshes = buildAllStoreyNavmeshes(fp, g);
      const grids = buildStoreyGrids(meshes, fp);
      const result = findGridMultiStoreyPath(
        grids,
        meshes,
        g,
        fp,
        { storeyId: "S1", point: { x: 7, y: 2 } },
        { storeyId: "S2", point: { x: 3, y: 3 } },
      );
      assert.equal(result.found, true);
      assert.deepEqual(
        result.segments.map((s) => s.storeyId),
        ["S1", "S2"],
      );
      assert.deepEqual(result.segments[0]!.points[0], { x: 7, y: 2 });
      const lastSeg = result.segments[1]!.points;
      assert.deepEqual(lastSeg[lastSeg.length - 1], { x: 3, y: 3 });
      assert.deepEqual(result.graphNodeIds, ["space:B", "space:A", "stair:ST", "space:C"]);
    });

    it("fails when the stair landing is blocked", () => {
      const meshes = buildAllStoreyNavmeshes(fp, g);
      const grids = buildStoreyGrids(meshes, fp);
      const result = findGridMultiStoreyPath(
        grids,
        meshes,
        g,
        fp,
        { storeyId: "S1", point: { x: 1, y: 1 } },
        { storeyId: "S2", point: { x: 3, y: 3 } },
        { blockedConnectorIds: new Set(["stair:ST@S1"]) },
      );
      assert.equal(result.found, false);
    });
  });
});
