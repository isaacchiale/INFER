import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAllStoreyNavmeshes,
  buildStoreyNavmesh,
  buildVerticalConnectors,
  computeBuildingEvacuationLoad,
  computeEvacuationLoad,
  doorIdFromVizEdge,
  findMultiStoreyNavmeshPath,
  findNavmeshPath,
  findNearestExitPath,
  regionAtPoint,
  type StoreyNavmesh,
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

    it("returns the full sequence of portals a route crosses, not just the final exit", () => {
      const mesh = buildStoreyNavmesh(footprintsWithExit, graphWithExit, "S1");
      const doorPortalId = mesh.portals.find((p) => p.kind === "door")!.id;
      const exitPortalId = mesh.portals.find((p) => p.kind === "exit")!.id;

      // From room A, the exit door is directly reachable — one hop.
      const fromA = findNearestExitPath(mesh, { x: 3, y: 2 }, footprintsWithExit);
      assert.deepEqual(fromA.portalIds, [exitPortalId]);

      // From room B, the route must cross the connecting door D, then the exit door E.
      const fromB = findNearestExitPath(mesh, { x: 6, y: 2 }, footprintsWithExit);
      assert.deepEqual(fromB.portalIds, [doorPortalId, exitPortalId]);
    });
  });

  describe("computeEvacuationLoad", () => {
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

    it("tallies every region's nearest-exit route onto the portals it crosses", () => {
      const mesh = buildStoreyNavmesh(footprintsWithExit, graphWithExit, "S1");
      const doorPortalId = mesh.portals.find((p) => p.kind === "door")!.id;
      const exitPortalId = mesh.portals.find((p) => p.kind === "exit")!.id;

      const result = computeEvacuationLoad(mesh, footprintsWithExit);

      // Both rooms are 4x4 = 16 m², weighted to max(16/10, 1) = 1.6
      // "occupants" each by regionOccupantWeight — not a flat 1-per-room
      // count. Both rooms' routes end at the exit door, so it carries both.
      const ROOM_WEIGHT = 1.6;
      assert.ok(Math.abs(result.portalLoad.get(exitPortalId)! - ROOM_WEIGHT * 2) < 1e-9);
      // Only room B's route needs to cross the connecting door first.
      assert.ok(Math.abs(result.portalLoad.get(doorPortalId)! - ROOM_WEIGHT) < 1e-9);
      assert.deepEqual(result.unreachableSpaceIds, []);
      assert.deepEqual(result.skippedSpaceIds, []);
    });

    it("weights a bigger room's contribution more than a small one instead of counting every room the same", () => {
      // Room A stays 4x4 = 16 m²; give room B a much bigger footprint
      // (20x20 = 400 m²) via a variant of footprintsWithExit, and route it
      // through the same door so the two rooms' contributions land on the
      // same portal and can be compared directly.
      const bigRoomFootprints: FootprintsDocument = {
        ...footprintsWithExit,
        spaces: footprintsWithExit.spaces.map((s) =>
          s.global_id === "B"
            ? {
                ...s,
                polygon: [
                  { x: 4, y: 0 },
                  { x: 24, y: 0 },
                  { x: 24, y: 20 },
                  { x: 4, y: 20 },
                ],
              }
            : s,
        ),
      };
      const mesh = buildStoreyNavmesh(bigRoomFootprints, graphWithExit, "S1");
      const doorPortalId = mesh.portals.find((p) => p.kind === "door")!.id;

      const result = computeEvacuationLoad(mesh, bigRoomFootprints);

      // Room A (16 m²) -> weight 1.6; Room B (400 m²) -> weight 40. Both
      // cross the same connecting door on their way to the exit.
      assert.ok(Math.abs(result.portalLoad.get(doorPortalId)! - 40) < 1e-6);
    });

    it("reports a region as unreachable (not just silently absent) when its only path out is blocked", () => {
      const mesh = buildStoreyNavmesh(footprintsWithExit, graphWithExit, "S1");
      const doorPortalId = mesh.portals.find((p) => p.kind === "door")!.id;

      const result = computeEvacuationLoad(mesh, footprintsWithExit, {
        blockedPortalIds: new Set([doorPortalId]),
      });

      assert.deepEqual(result.unreachableSpaceIds, ["space:B"]);
      // Room A's own route to the exit is unaffected by B's isolation.
      // Room A is 4x4 = 16 m² -> regionOccupantWeight = max(16/10, 1) = 1.6.
      const exitPortalId = mesh.portals.find((p) => p.kind === "exit")!.id;
      assert.ok(Math.abs(result.portalLoad.get(exitPortalId)! - 1.6) < 1e-9);
    });

    describe("stairs as evacuation targets", () => {
      // Storey S2 has no exterior "exit" door anywhere — the realistic
      // shape of every upper floor of a real multi-storey building. Room U
      // only connects out via the stair "ST".
      const upperFloorFootprints: FootprintsDocument = {
        schema_version: "1.0",
        model_id: "t",
        coordinate_system: "ifc_world_xy_metres",
        storeys: [
          { global_id: "S1", name: "L1", elevation: 0 },
          { global_id: "S2", name: "L2", elevation: 3 },
        ],
        spaces: [
          {
            global_id: "U",
            name: "U",
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
        doors: [],
      };

      const upperFloorGraph: ConnectivityGraph = {
        schema_version: "1.0",
        model_id: "t",
        variant: "geometry",
        nodes: [
          { id: "space:U", kind: "space", global_id: "U", name: "U", storey_global_id: "S2" },
          { id: "stair:ST", kind: "stair", global_id: "ST", name: "Stair", storey_global_id: "S1" },
        ],
        edges: [
          {
            id: "vertical:ST:U:geom",
            kind: "vertical",
            source: "space:U",
            target: "stair:ST",
            method: "geom_stair_space",
            inferred: true,
          },
        ],
      };

      it("treats a stair landing as a valid exit when the connectivity graph is given, instead of flagging every room unreachable", () => {
        const mesh = buildStoreyNavmesh(upperFloorFootprints, upperFloorGraph, "S2");
        const result = computeEvacuationLoad(mesh, upperFloorFootprints, {}, upperFloorGraph);

        assert.deepEqual(result.unreachableSpaceIds, []);
        assert.equal(result.stairNodes.length, 1);
        const stairId = result.stairNodes[0]!.id;
        // Room U is 4x4 = 16 m² -> regionOccupantWeight = max(16/10, 1) = 1.6.
        assert.ok(Math.abs(result.portalLoad.get(stairId)! - 1.6) < 1e-9);
      });

      it("without a connectivity graph, falls back to the old (misleading on upper floors) behaviour rather than guessing", () => {
        const mesh = buildStoreyNavmesh(upperFloorFootprints, upperFloorGraph, "S2");
        const result = computeEvacuationLoad(mesh, upperFloorFootprints);

        assert.deepEqual(result.unreachableSpaceIds, ["space:U"]);
        assert.deepEqual(result.stairNodes, []);
      });

      it("respects blockedPortalIds for a stair landing's synthetic node id", () => {
        const mesh = buildStoreyNavmesh(upperFloorFootprints, upperFloorGraph, "S2");
        const firstPass = computeEvacuationLoad(mesh, upperFloorFootprints, {}, upperFloorGraph);
        const stairId = firstPass.stairNodes[0]!.id;

        const blocked = computeEvacuationLoad(mesh, upperFloorFootprints, { blockedPortalIds: new Set([stairId]) }, upperFloorGraph);
        assert.deepEqual(blocked.unreachableSpaceIds, ["space:U"]);
        assert.deepEqual(blocked.stairNodes, []);
      });
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

describe("computeEvacuationLoad performance", () => {
  /**
   * Reproduces the actual hang: a naive implementation calls
   * findNearestExitPath (and therefore buildPortalGraph) once per room, and
   * buildPortalGraph's per-region geometry scans every wall/furniture/
   * opening in the *entire model* — so an O(rooms) job silently became
   * O(rooms x walls). A row of 40 rooms with a few hundred walls present
   * elsewhere in the model (never overlapping any of them — they only need
   * to be in the array to make a naive full-array rescan expensive) is
   * enough to turn a many-minute-scale blowup into a clearly-failing test
   * at a generous budget, without needing an actual multi-second real
   * timeout in CI.
   */
  it("stays fast for many rooms sharing a large model instead of rescanning all walls per room", () => {
    const ROOM_COUNT = 40;
    const WALL_COUNT = 300;
    const ROOM_W = 4;

    const spaces: FootprintsDocument["spaces"] = [];
    const doors: FootprintsDocument["doors"] = [];
    const nodes: ConnectivityGraph["nodes"] = [];
    const edges: ConnectivityGraph["edges"] = [];

    for (let i = 0; i < ROOM_COUNT; i++) {
      const gid = `R${i}`;
      spaces.push({
        global_id: gid,
        name: gid,
        storey_global_id: "S1",
        polygon: [
          { x: i * ROOM_W, y: 0 },
          { x: (i + 1) * ROOM_W, y: 0 },
          { x: (i + 1) * ROOM_W, y: ROOM_W },
          { x: i * ROOM_W, y: ROOM_W },
        ],
        incomplete: false,
        method: "ifc_placement_bbox",
      });
      nodes.push({ id: `space:${gid}`, kind: "space", global_id: gid, name: gid, storey_global_id: "S1" });
    }

    // Connect each room to the next; an exit on room 0 only.
    for (let i = 0; i < ROOM_COUNT - 1; i++) {
      const dgid = `D${i}`;
      doors.push({
        global_id: dgid,
        name: dgid,
        storey_global_id: "S1",
        point: { x: (i + 1) * ROOM_W, y: ROOM_W / 2 },
        segment: [
          { x: (i + 1) * ROOM_W, y: ROOM_W / 2 - 0.5 },
          { x: (i + 1) * ROOM_W, y: ROOM_W / 2 + 0.5 },
        ],
        incomplete: false,
        method: "ifc_object_placement",
      });
      nodes.push({ id: `door:${dgid}`, kind: "door", global_id: dgid, name: dgid, storey_global_id: "S1" });
      edges.push(
        {
          id: `space_door:R${i}:${dgid}:geom`,
          kind: "space_door",
          source: `space:R${i}`,
          target: `door:${dgid}`,
          method: "geom_door_space",
          inferred: true,
        },
        {
          id: `space_door:R${i + 1}:${dgid}:geom`,
          kind: "space_door",
          source: `space:R${i + 1}`,
          target: `door:${dgid}`,
          method: "geom_door_space",
          inferred: true,
        },
      );
    }
    doors.push({
      global_id: "EXIT",
      name: "EXIT",
      storey_global_id: "S1",
      point: { x: 0, y: ROOM_W / 2 },
      segment: [
        { x: 0, y: ROOM_W / 2 - 0.5 },
        { x: 0, y: ROOM_W / 2 + 0.5 },
      ],
      incomplete: false,
      method: "ifc_object_placement",
    });
    nodes.push({ id: "door:EXIT", kind: "door", global_id: "EXIT", name: "EXIT", storey_global_id: "S1" });
    edges.push({
      id: "space_door:R0:EXIT:ifc",
      kind: "space_door",
      source: "space:R0",
      target: "door:EXIT",
      method: "ifc_rel_space_boundary",
      inferred: false,
    });

    // Present in the model, overlapping nothing — pure scan-cost padding.
    const walls: FootprintsDocument["walls"] = [];
    for (let i = 0; i < WALL_COUNT; i++) {
      const x = 100_000 + i * 2;
      walls.push({
        global_id: `W${i}`,
        name: `W${i}`,
        storey_global_id: "S1",
        polygon: [
          { x, y: 0 },
          { x: x + 1, y: 0 },
          { x: x + 1, y: 1 },
          { x, y: 1 },
        ],
        incomplete: false,
        method: "ifc_placement_bbox",
      });
    }
    // A much larger batch on an entirely different storey. footprintOverlapsSpace
    // already rejects these cheaply either way, so this isn't primarily a
    // performance guard on its own — it's here to prove storey-scoping
    // doesn't change the *result* (same load/unreachable counts below,
    // computed against bigFootprints which includes these) while also
    // adding real headroom to the timing budget for a multi-storey building
    // where the "other floors'" wall count can dwarf this one's.
    const OTHER_STOREY_WALL_COUNT = 6000;
    for (let i = 0; i < OTHER_STOREY_WALL_COUNT; i++) {
      const x = -100_000 - i * 2;
      walls.push({
        global_id: `OW${i}`,
        name: `OW${i}`,
        storey_global_id: "S2",
        polygon: [
          { x, y: 0 },
          { x: x + 1, y: 0 },
          { x: x + 1, y: 1 },
          { x, y: 1 },
        ],
        incomplete: false,
        method: "ifc_placement_bbox",
      });
    }

    const bigFootprints: FootprintsDocument = {
      schema_version: "1.0",
      model_id: "perf",
      coordinate_system: "ifc_world_xy_metres",
      storeys: [{ global_id: "S1", name: "L1", elevation: 0 }],
      spaces,
      doors,
      walls,
    };
    const bigGraph: ConnectivityGraph = {
      schema_version: "1.0",
      model_id: "perf",
      variant: "geometry",
      nodes,
      edges,
    };

    const mesh = buildStoreyNavmesh(bigFootprints, bigGraph, "S1");

    const startedAt = Date.now();
    const result = computeEvacuationLoad(mesh, bigFootprints);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.unreachableSpaceIds.length, 0);
    assert.equal(result.skippedSpaceIds.length, 0);
    // Each room is ROOM_W x ROOM_W = 16 m² -> regionOccupantWeight = 1.6.
    const expectedExitLoad = ROOM_COUNT * 1.6;
    assert.ok(
      Math.abs(result.portalLoad.get("viz-exit:door:EXIT:space:R0")! - expectedExitLoad) < 1e-6,
    );
    // A regression back to "rebuild the graph (and rescan every wall) once
    // per room" would take many seconds to minutes at this scale, not
    // milliseconds — 2s is a generous budget with headroom for a slow CI
    // box, while still clearly failing on that regression.
    assert.ok(elapsedMs < 2000, `computeEvacuationLoad took ${elapsedMs}ms for ${ROOM_COUNT} rooms`);
  });
});

describe("computeBuildingEvacuationLoad", () => {
  // S1 (ground floor): room A has a real exit door E, and the stair ST
  // lands inside it too. S2 (upper floor): room U has no exit of its own —
  // only the same stair ST, landing inside it.
  const twoStoreyFootprints: FootprintsDocument = {
    schema_version: "1.0",
    model_id: "t",
    coordinate_system: "ifc_world_xy_metres",
    storeys: [
      { global_id: "S1", name: "L1", elevation: 0 },
      { global_id: "S2", name: "L2", elevation: 3 },
    ],
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
        global_id: "U",
        name: "U",
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
    doors: [
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

  const twoStoreyGraph: ConnectivityGraph = {
    schema_version: "1.0",
    model_id: "t",
    variant: "geometry",
    nodes: [
      { id: "space:A", kind: "space", global_id: "A", name: "A", storey_global_id: "S1" },
      { id: "space:U", kind: "space", global_id: "U", name: "U", storey_global_id: "S2" },
      { id: "door:E", kind: "door", global_id: "E", name: "E", storey_global_id: "S1" },
      { id: "stair:ST", kind: "stair", global_id: "ST", name: "Stair", storey_global_id: "S1" },
    ],
    edges: [
      {
        id: "space_door:A:E:ifc",
        kind: "space_door",
        source: "space:A",
        target: "door:E",
        method: "ifc_rel_space_boundary",
        inferred: false,
      },
      {
        id: "vertical:ST:A:geom",
        kind: "vertical",
        source: "space:A",
        target: "stair:ST",
        method: "geom_stair_space",
        inferred: true,
      },
      {
        id: "vertical:ST:U:geom",
        kind: "vertical",
        source: "space:U",
        target: "stair:ST",
        method: "geom_stair_space",
        inferred: true,
      },
    ],
  };

  function buildTwoStoreyMeshes(): StoreyNavmesh[] {
    return [
      buildStoreyNavmesh(twoStoreyFootprints, twoStoreyGraph, "S1"),
      buildStoreyNavmesh(twoStoreyFootprints, twoStoreyGraph, "S2"),
    ];
  }

  it("chains an upper floor's route through the stair down to a real exit on another storey, without detouring room A's own direct route through it", () => {
    const meshes = buildTwoStoreyMeshes();
    const result = computeBuildingEvacuationLoad(meshes, twoStoreyFootprints, twoStoreyGraph);

    assert.deepEqual(result.unreachableSpaceIds, []);
    assert.deepEqual(result.skippedSpaceIds, []);
    assert.equal(result.stairNodes.length, 2); // one landing per storey

    const s1Mesh = meshes[0]!;
    const exitPortalId = s1Mesh.portals.find((p) => p.kind === "exit")!.id;
    const s1StairId = result.stairNodes.find((n) => n.storeyId === "S1")!.id;
    const s2StairId = result.stairNodes.find((n) => n.storeyId === "S2")!.id;

    // Room U (16 m² -> weight 1.6) has to cross its own stair landing, the
    // ground-floor stair landing, and finally the real exit — all three
    // should show its load, not just wherever its simulation "stops". Room
    // A (also 1.6) borders the exit directly, so the exit carries *both*
    // rooms' weight — but room A never needs the stair (it already has a
    // door straight onto the exit), so the stair nodes carry only room U's.
    assert.ok(Math.abs(result.portalLoad.get(s2StairId)! - 1.6) < 1e-6);
    assert.ok(Math.abs(result.portalLoad.get(s1StairId)! - 1.6) < 1e-6);
    assert.ok(Math.abs(result.portalLoad.get(exitPortalId)! - 3.2) < 1e-6);
  });

  it("gives each room its own real walking distance to the nearest exit, not just whether one exists", () => {
    const meshes = buildTwoStoreyMeshes();
    const result = computeBuildingEvacuationLoad(meshes, twoStoreyFootprints, twoStoreyGraph);

    const distA = result.regionDistanceToExit.get("space:A");
    const distU = result.regionDistanceToExit.get("space:U");
    assert.ok(distA != null && distA > 0, "room A should have a positive distance to its direct exit");
    assert.ok(distU != null && distU > 0, "room U should have a positive distance to the exit");
    // Room U has to reach its own stair landing, ride down to room A's
    // landing, then cross A to the real exit — strictly farther than A's
    // own direct hop to that same exit.
    assert.ok(distU! > distA!, "room U (via stair + room A) should be farther than room A's direct hop");
  });

  it("reports every room in the building unreachable when there's no exit anywhere", () => {
    const noExitFootprints: FootprintsDocument = { ...twoStoreyFootprints, doors: [] };
    const noExitGraph: ConnectivityGraph = {
      ...twoStoreyGraph,
      nodes: twoStoreyGraph.nodes.filter((n) => n.id !== "door:E"),
      edges: twoStoreyGraph.edges.filter((e) => e.id !== "space_door:A:E:ifc"),
    };
    const meshes = [
      buildStoreyNavmesh(noExitFootprints, noExitGraph, "S1"),
      buildStoreyNavmesh(noExitFootprints, noExitGraph, "S2"),
    ];
    const result = computeBuildingEvacuationLoad(meshes, noExitFootprints, noExitGraph);

    assert.deepEqual(result.unreachableSpaceIds.sort(), ["space:A", "space:U"]);
    assert.equal(result.portalLoad.size, 0);
    assert.equal(result.regionDistanceToExit.size, 0);
  });

  it("isolates the upper floor when its connecting stair landing is blocked", () => {
    const meshes = buildTwoStoreyMeshes();
    const result = computeBuildingEvacuationLoad(meshes, twoStoreyFootprints, twoStoreyGraph, {
      blockedConnectorIds: new Set(["stair:ST@S2"]),
    });

    assert.deepEqual(result.unreachableSpaceIds, ["space:U"]);
    assert.ok(!result.regionDistanceToExit.has("space:U"));
    assert.ok(result.regionDistanceToExit.has("space:A"));
    // Room A is unaffected — it never needed the stair to begin with.
    const s1Mesh = meshes[0]!;
    const exitPortalId = s1Mesh.portals.find((p) => p.kind === "exit")!.id;
    assert.ok(Math.abs(result.portalLoad.get(exitPortalId)! - 1.6) < 1e-6);
  });
});

describe("computeBuildingEvacuationLoad performance", () => {
  /**
   * Reproduces a real scaling risk in the cross-storey vertical-connector
   * linking step: for every stair/lift, every *pair* of storeys it spans
   * used to look up each storey's elevation via Array.find() over *every*
   * storey in the building (verticalHopCost) — turning an O(pairs) linking
   * pass into O(pairs x storeys). A tall building with several stairs
   * spanning the whole height (realistic for a high-rise's fire stairs) is
   * enough to turn that into tens of millions of comparisons with a naive
   * implementation, at a generous budget that stays fast once the lookup is
   * an O(1) map instead.
   */
  it("stays fast for a tall building with several full-height stairs", () => {
    const STOREY_COUNT = 150;
    const STAIR_COUNT = 10;

    const storeys: FootprintsDocument["storeys"] = [];
    const spaces: FootprintsDocument["spaces"] = [];
    const doors: FootprintsDocument["doors"] = [];
    const nodes: ConnectivityGraph["nodes"] = [];
    const edges: ConnectivityGraph["edges"] = [];

    for (let s = 0; s < STOREY_COUNT; s++) {
      const storeyId = `S${s}`;
      storeys.push({ global_id: storeyId, name: `L${s}`, elevation: s * 3 });
      const roomId = `R${s}`;
      spaces.push({
        global_id: roomId,
        name: roomId,
        storey_global_id: storeyId,
        polygon: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 4 },
          { x: 0, y: 4 },
        ],
        incomplete: false,
        method: "ifc_placement_bbox",
      });
      nodes.push({
        id: `space:${roomId}`,
        kind: "space",
        global_id: roomId,
        name: roomId,
        storey_global_id: storeyId,
      });

      for (let st = 0; st < STAIR_COUNT; st++) {
        const stairId = `ST${st}`;
        if (s === 0) {
          nodes.push({
            id: `stair:${stairId}`,
            kind: "stair",
            global_id: stairId,
            name: stairId,
            storey_global_id: storeyId,
          });
        }
        edges.push({
          id: `vertical:${stairId}:${roomId}:geom`,
          kind: "vertical",
          source: `space:${roomId}`,
          target: `stair:${stairId}`,
          method: "geom_stair_space",
          inferred: true,
        });
      }
    }

    // One real exit, ground floor only — every other room only reaches it
    // by chaining through a stair, which is what exercises the connector
    // linking step being guarded here.
    doors.push({
      global_id: "EXIT",
      name: "EXIT",
      storey_global_id: "S0",
      point: { x: 0, y: 2 },
      segment: [
        { x: 0, y: 1.5 },
        { x: 0, y: 2.5 },
      ],
      incomplete: false,
      method: "ifc_object_placement",
    });
    nodes.push({
      id: "door:EXIT",
      kind: "door",
      global_id: "EXIT",
      name: "EXIT",
      storey_global_id: "S0",
    });
    edges.push({
      id: "space_door:R0:EXIT:ifc",
      kind: "space_door",
      source: "space:R0",
      target: "door:EXIT",
      method: "ifc_rel_space_boundary",
      inferred: false,
    });

    const footprints: FootprintsDocument = {
      schema_version: "1.0",
      model_id: "perf-tall",
      coordinate_system: "ifc_world_xy_metres",
      storeys,
      spaces,
      doors,
    };
    const graph: ConnectivityGraph = {
      schema_version: "1.0",
      model_id: "perf-tall",
      variant: "geometry",
      nodes,
      edges,
    };

    // buildAllStoreyNavmeshes, not a per-storey buildStoreyNavmesh loop — the
    // latter recomputes toDisplayGraph(graph) and the spaces/doors/edges
    // lookup maps from scratch on every call (see buildStoreyNavmesh's own
    // `display`/`spaceById` doc comments), an O(storeys x graph size) trap
    // independent of the thing this test means to isolate. This is exactly
    // how the real app builds them (useNavmeshRouting), and it's kept
    // outside the timed section below to match: by the time a user actually
    // toggles evacuation load on, the app's own meshes are already built
    // and memoized from other state, not rebuilt on the toggle itself.
    const meshes = buildAllStoreyNavmeshes(footprints, graph);

    const startedAt = Date.now();
    const result = computeBuildingEvacuationLoad(meshes, footprints, graph);
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(result.unreachableSpaceIds, []);
    assert.equal(result.stairNodes.length, STOREY_COUNT * STAIR_COUNT);
    assert.ok(
      elapsedMs < 1500,
      `computeBuildingEvacuationLoad took ${elapsedMs}ms for ${STOREY_COUNT} storeys x ${STAIR_COUNT} full-height stairs`,
    );
  });
});
