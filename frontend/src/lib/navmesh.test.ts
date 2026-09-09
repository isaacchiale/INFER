import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStoreyNavmesh, doorIdFromVizEdge, findNavmeshPath, regionAtPoint } from "./navmesh.ts";
import type { ConnectivityGraph } from "../types/graph.ts";
import type { FootprintsDocument } from "../types/footprints.ts";

const footprints: FootprintsDocument = {
  schema_version: "1.0",
  model_id: "t",
  coordinate_system: "ifc_world_xy_metres",
  storeys: [{ global_id: "S1", name: "L1", elevation: 0 }],
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
        { x: 8, y: 0 },
        { x: 8, y: 4 },
        { x: 4, y: 4 },
      ],
      incomplete: false,
      method: "ifc_placement_bbox",
    },
  ],
  doors: [
    {
      global_id: "D",
      name: "D",
      storey_global_id: "S1",
      point: { x: 4, y: 2 },
      segment: [
        { x: 4, y: 1.5 },
        { x: 4, y: 2.5 },
      ],
      incomplete: false,
      method: "ifc_object_placement",
    },
  ],
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
  edges: [
    {
      id: "space_door:A:D:geom",
      kind: "space_door",
      source: "space:A",
      target: "door:D",
      method: "geom_door_space",
      inferred: true,
    },
    {
      id: "space_door:B:D:geom",
      kind: "space_door",
      source: "space:B",
      target: "door:D",
      method: "geom_door_space",
      inferred: true,
    },
  ],
};

describe("navmesh", () => {
  it("parses viz-door edge ids", () => {
    assert.equal(
      doorIdFromVizEdge("viz-door:door:D:space:A:space:B"),
      "door:D",
    );
  });

  it("builds regions and door portals for one storey", () => {
    const mesh = buildStoreyNavmesh(footprints, graph, "S1");
    assert.equal(mesh.regions.length, 2);
    assert.equal(mesh.portals.length, 1);
    assert.equal(mesh.portals[0]!.kind, "door");
    assert.equal(mesh.portals[0]!.inferred, true);
    assert.deepEqual(mesh.portals[0]!.point, { x: 4, y: 2 });
  });

  it("marks IFC door portals as not inferred", () => {
    const ifcGraph: ConnectivityGraph = {
      ...graph,
      edges: [
        {
          id: "space_door:A:D:ifc",
          kind: "space_door",
          source: "space:A",
          target: "door:D",
          method: "ifc_rel_space_boundary",
          inferred: false,
        },
        {
          id: "space_door:B:D:ifc",
          kind: "space_door",
          source: "space:B",
          target: "door:D",
          method: "ifc_rel_space_boundary",
          inferred: false,
        },
      ],
    };
    const mesh = buildStoreyNavmesh(footprints, ifcGraph, "S1");
    assert.equal(mesh.portals.length, 1);
    assert.equal(mesh.portals[0]!.kind, "door");
    assert.equal(mesh.portals[0]!.inferred, false);
  });

  it("skips soft-disabled display edges", () => {
    const mesh = buildStoreyNavmesh(footprints, graph, "S1", {
      excludedEdgeIds: new Set(["viz-door:door:D:space:A:space:B"]),
    });
    assert.equal(mesh.portals.length, 0);
  });

  it("finds same-region A* path", () => {
    const mesh = buildStoreyNavmesh(footprints, graph, "S1");
    const a = regionAtPoint(mesh, { x: 1, y: 1 });
    assert.equal(a?.globalId, "A");
    const path = findNavmeshPath(mesh, { x: 1, y: 1 }, { x: 3, y: 3 }, footprints);
    assert.equal(path.found, true);
    assert.ok(path.points.length >= 2);
  });

  it("finds cross-portal A* path A→B", () => {
    const mesh = buildStoreyNavmesh(footprints, graph, "S1");
    const path = findNavmeshPath(mesh, { x: 1, y: 2 }, { x: 7, y: 2 }, footprints);
    assert.equal(path.found, true);
    assert.ok(path.points.length >= 2);
    // Path should reach near the door and into B.
    const nearDoor = path.points.some((p) => Math.hypot(p.x - 4, p.y - 2) < 0.5);
    assert.ok(nearDoor, "expected path through door portal");
    const last = path.points[path.points.length - 1]!;
    assert.ok(last.x > 4, "expected end in room B");
  });

  it("fails when no portal connects regions", () => {
    const mesh = buildStoreyNavmesh(footprints, graph, "S1", {
      excludedEdgeIds: new Set(["viz-door:door:D:space:A:space:B"]),
    });
    const path = findNavmeshPath(mesh, { x: 1, y: 2 }, { x: 7, y: 2 }, footprints);
    assert.equal(path.found, false);
  });
});
