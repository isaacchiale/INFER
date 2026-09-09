import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blockedEdgeIdsFromExclusions,
  toDisplayGraph,
} from "./graph-layout.ts";
import type { ConnectivityGraph } from "../types/graph.ts";

function graph(partial: Partial<ConnectivityGraph> & Pick<ConnectivityGraph, "nodes" | "edges">): ConnectivityGraph {
  return {
    schema_version: "1.0",
    model_id: "t",
    variant: "geometry",
    ...partial,
  };
}

describe("blockedEdgeIdsFromExclusions", () => {
  it("expands viz-door display edges into both space_door legs", () => {
    const g = graph({
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
    });

    const display = toDisplayGraph(g);
    const viz = display.edges.find((e) => e.id.startsWith("viz-door:"));
    assert.ok(viz, "expected collapsed door viz edge");

    const blocked = blockedEdgeIdsFromExclusions(g, new Set([viz.id]));
    assert.ok(blocked.includes("space_door:A:D:geom"));
    assert.ok(blocked.includes("space_door:B:D:geom"));
    assert.equal(blocked.includes(viz.id), false);
  });

  it("blocks direct space_space and shared-door bridges for the same pair", () => {
    const g = graph({
      nodes: [
        { id: "space:A", kind: "space", global_id: "A", name: "A", storey_global_id: "S1" },
        { id: "space:B", kind: "space", global_id: "B", name: "B", storey_global_id: "S1" },
        { id: "door:D", kind: "door", global_id: "D", name: "D", storey_global_id: "S1" },
      ],
      edges: [
        {
          id: "space_space:A:B:opening:O:geom",
          kind: "space_space",
          source: "space:A",
          target: "space:B",
          method: "geom_opening_space",
          inferred: true,
        },
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
    });

    const blocked = blockedEdgeIdsFromExclusions(
      g,
      new Set(["space_space:A:B:opening:O:geom"]),
    );
    assert.ok(blocked.includes("space_space:A:B:opening:O:geom"));
    assert.ok(blocked.includes("space_door:A:D:geom"));
    assert.ok(blocked.includes("space_door:B:D:geom"));
  });

  it("does not block unrelated door legs", () => {
    const g = graph({
      nodes: [
        { id: "space:A", kind: "space", global_id: "A", name: "A", storey_global_id: "S1" },
        { id: "space:B", kind: "space", global_id: "B", name: "B", storey_global_id: "S1" },
        { id: "space:C", kind: "space", global_id: "C", name: "C", storey_global_id: "S1" },
        { id: "door:D1", kind: "door", global_id: "D1", name: "D1", storey_global_id: "S1" },
        { id: "door:D2", kind: "door", global_id: "D2", name: "D2", storey_global_id: "S1" },
      ],
      edges: [
        {
          id: "space_door:A:D1:geom",
          kind: "space_door",
          source: "space:A",
          target: "door:D1",
          method: "geom_door_space",
          inferred: true,
        },
        {
          id: "space_door:B:D1:geom",
          kind: "space_door",
          source: "space:B",
          target: "door:D1",
          method: "geom_door_space",
          inferred: true,
        },
        {
          id: "space_door:B:D2:geom",
          kind: "space_door",
          source: "space:B",
          target: "door:D2",
          method: "geom_door_space",
          inferred: true,
        },
        {
          id: "space_door:C:D2:geom",
          kind: "space_door",
          source: "space:C",
          target: "door:D2",
          method: "geom_door_space",
          inferred: true,
        },
      ],
    });

    const display = toDisplayGraph(g);
    const ab = display.edges.find(
      (e) =>
        (e.source === "space:A" && e.target === "space:B") ||
        (e.source === "space:B" && e.target === "space:A"),
    );
    assert.ok(ab);

    const blocked = new Set(blockedEdgeIdsFromExclusions(g, new Set([ab.id])));
    assert.ok(blocked.has("space_door:A:D1:geom"));
    assert.ok(blocked.has("space_door:B:D1:geom"));
    assert.equal(blocked.has("space_door:B:D2:geom"), false);
    assert.equal(blocked.has("space_door:C:D2:geom"), false);
  });
});
