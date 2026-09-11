import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAllStoreyNavmeshes,
  buildStoreyNavmesh,
  buildVerticalConnectors,
  doorIdFromVizEdge,
  findMultiStoreyNavmeshPath,
  findNavmeshPath,
  findNearestExitPath,
  regionAtPoint,
} from "./navmesh.ts";
import { pointInPolygon } from "./geometric-path.ts";
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
    assert.equal(mesh.portals[0]!.doorGlobalId, "D");
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

  it("routes around a furniture obstacle inside a single region", () => {
    // A desk-shaped strip splitting room A almost top-to-bottom, directly in
    // the way of the straight line between the two pick points below —
    // proves furniture actually reaches findNavmeshPath's local A*, not just
    // the low-level astarInPolygon it happens to share code with.
    const desk = {
      global_id: "Desk",
      name: "Desk",
      storey_global_id: "S1",
      polygon: [
        { x: 1.8, y: 0.5 },
        { x: 2.2, y: 0.5 },
        { x: 2.2, y: 3.5 },
        { x: 1.8, y: 3.5 },
      ],
      incomplete: false,
      method: "ifc_placement_bbox" as const,
    };
    const fp: FootprintsDocument = { ...footprints, furniture: [desk] };
    const mesh = buildStoreyNavmesh(fp, graph, "S1");

    const path = findNavmeshPath(mesh, { x: 0.5, y: 2 }, { x: 3.5, y: 2 }, fp);
    assert.equal(path.found, true);
    for (const p of path.points) {
      assert.ok(!pointInPolygon(p.x, p.y, desk.polygon), `path cut through the desk at ${p.x},${p.y}`);
    }
    // The direct straight line runs at y=2, straight through the desk — a
    // real detour must leave that line, not hug it.
    assert.ok(
      path.points.some((p) => Math.abs(p.y - 2) > 0.3),
      "expected a detour around the desk, not a straight line through it",
    );
  });

  describe("exit portals", () => {
    const footprintsWithExit: FootprintsDocument = {
      ...footprints,
      doors: [
        ...footprints.doors,
        {
          global_id: "E",
          name: "E",
          storey_global_id: "S1",
          point: { x: 0, y: 2 },
          segment: [
            { x: 0, y: 1.5 },
            { x: 0, y: 2.5 },
          ],
          incomplete: false,
          method: "ifc_object_placement",
        },
      ],
    };

    const graphWithExit: ConnectivityGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: "door:E", kind: "door", global_id: "E", name: "E", storey_global_id: "S1" },
      ],
      edges: [
        ...graph.edges,
        {
          id: "space_door:A:E:ifc",
          kind: "space_door",
          source: "space:A",
          target: "door:E",
          method: "ifc_rel_space_boundary",
          inferred: false,
        },
      ],
    };

    it("builds an exit portal for a door with exactly one linked space", () => {
      const mesh = buildStoreyNavmesh(footprintsWithExit, graphWithExit, "S1");
      const exits = mesh.portals.filter((p) => p.kind === "exit");
      assert.equal(exits.length, 1);
      assert.equal(exits[0]!.spaceA, "space:A");
      assert.equal(exits[0]!.spaceB, null);
      assert.deepEqual(exits[0]!.point, { x: 0, y: 2 });
      assert.equal(exits[0]!.doorGlobalId, "E");
      // Two-sided door D is still a regular door portal, not an exit.
      assert.equal(mesh.portals.filter((p) => p.kind === "door").length, 1);
    });

    it("routes to the nearest exit from inside a region", () => {
      const mesh = buildStoreyNavmesh(footprintsWithExit, graphWithExit, "S1");
      const result = findNearestExitPath(mesh, { x: 3, y: 2 }, footprintsWithExit);
      assert.equal(result.found, true);
      assert.equal(result.exitPortalId, "viz-exit:door:E:space:A");
      const last = result.points[result.points.length - 1]!;
      assert.ok(
        Math.hypot(last.x - 0, last.y - 2) < 0.5,
        "expected path to end near the exit door",
      );
    });

    it("reports no reachable exit from a region with none", () => {
      const mesh = buildStoreyNavmesh(footprintsWithExit, graphWithExit, "S1");
      const doorPortalId = mesh.portals.find((p) => p.kind === "door")!.id;
      // Blocking the only door between B and A isolates B from the exit on A.
      const result = findNearestExitPath(mesh, { x: 6, y: 2 }, footprintsWithExit, {
        blockedPortalIds: new Set([doorPortalId]),
      });
      assert.equal(result.found, false);
    });
  });

  describe("blocked portals", () => {
    it("routes around a blocked portal via findNavmeshPath", () => {
      const mesh = buildStoreyNavmesh(footprints, graph, "S1");
      const blocked = findNavmeshPath(mesh, { x: 1, y: 2 }, { x: 7, y: 2 }, footprints, {
        blockedPortalIds: new Set([mesh.portals[0]!.id]),
      });
      assert.equal(blocked.found, false);
      assert.equal(blocked.note, "No portal path between regions");

      const open = findNavmeshPath(mesh, { x: 1, y: 2 }, { x: 7, y: 2 }, footprints);
      assert.equal(open.found, true);
    });
  });

  describe("vertical linking across storeys", () => {
    const multiStoreyFootprints: FootprintsDocument = {
      ...footprints,
      storeys: [
        { global_id: "S1", name: "L1", elevation: 0 },
        { global_id: "S2", name: "L2", elevation: 3 },
      ],
      spaces: [
        ...footprints.spaces,
        {
          global_id: "C",
          name: "C",
          storey_global_id: "S2",
          polygon: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 4 },
            { x: 0, y: 4 },
          ],
          incomplete: false,
          method: "ifc_placement_bbox",
        },
      ],
    };

    const multiStoreyGraph: ConnectivityGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: "space:C", kind: "space", global_id: "C", name: "C", storey_global_id: "S2" },
        { id: "stair:ST", kind: "stair", global_id: "ST", name: "Stair", storey_global_id: "S1" },
      ],
      edges: [
        ...graph.edges,
        {
          id: "vertical:ST:A:geom",
          kind: "vertical",
          source: "space:A",
          target: "stair:ST",
          method: "geom_stair_space",
          inferred: true,
        },
        {
          id: "vertical:ST:C:geom",
          kind: "vertical",
          source: "space:C",
          target: "stair:ST",
          method: "geom_stair_space",
          inferred: true,
        },
      ],
    };

    it("groups vertical edges by stair id across storeys", () => {
      const connectors = buildVerticalConnectors(multiStoreyGraph, multiStoreyFootprints);
      const stairConnectors = connectors.get("stair:ST");
      assert.ok(stairConnectors);
      assert.equal(stairConnectors!.length, 2);
      assert.deepEqual(stairConnectors!.map((c) => c.storeyId).sort(), ["S1", "S2"]);
    });

    it("routes across storeys through a shared stair", () => {
      const meshes = buildAllStoreyNavmeshes(multiStoreyFootprints, multiStoreyGraph);
      assert.equal(meshes.length, 2);
      const result = findMultiStoreyNavmeshPath(
        meshes,
        multiStoreyGraph,
        multiStoreyFootprints,
        { storeyId: "S1", point: { x: 1, y: 1 } },
        { storeyId: "S2", point: { x: 3, y: 3 } },
      );
      assert.equal(result.found, true);
      assert.equal(result.segments.length, 2);
      assert.equal(result.segments[0]!.storeyId, "S1");
      assert.equal(result.segments[1]!.storeyId, "S2");
    });

    it("fails when the connecting stair landing is blocked", () => {
      const meshes = buildAllStoreyNavmeshes(multiStoreyFootprints, multiStoreyGraph);
      const result = findMultiStoreyNavmeshPath(
        meshes,
        multiStoreyGraph,
        multiStoreyFootprints,
        { storeyId: "S1", point: { x: 1, y: 1 } },
        { storeyId: "S2", point: { x: 3, y: 3 } },
        { blockedConnectorIds: new Set(["stair:ST@S1"]) },
      );
      assert.equal(result.found, false);
    });

    it("delegates to findNavmeshPath for a same-storey request", () => {
      const meshes = buildAllStoreyNavmeshes(footprints, graph);
      const result = findMultiStoreyNavmeshPath(
        meshes,
        graph,
        footprints,
        { storeyId: "S1", point: { x: 1, y: 2 } },
        { storeyId: "S1", point: { x: 7, y: 2 } },
      );
      assert.equal(result.found, true);
      assert.equal(result.segments.length, 1);
    });
  });
});
