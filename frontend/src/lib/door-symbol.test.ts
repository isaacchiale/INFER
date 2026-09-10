import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDoorGlyph, classifyDoorOperation } from "./door-symbol.ts";

function parsePoints(d: string): { x: number; y: number }[] {
  return d
    .split(/(?=[ML])/)
    .filter(Boolean)
    .map((tok) => {
      const [x, y] = tok.slice(1).trim().split(/\s+/).map(Number);
      return { x: x!, y: y! };
    });
}

describe("classifyDoorOperation", () => {
  it("returns null for missing/unset operation types", () => {
    assert.equal(classifyDoorOperation(null), null);
    assert.equal(classifyDoorOperation(undefined), null);
    assert.equal(classifyDoorOperation(""), null);
    assert.equal(classifyDoorOperation("NOTDEFINED"), null);
  });

  it("classifies single swing doors", () => {
    assert.equal(classifyDoorOperation("SINGLE_SWING_LEFT"), "swing_left");
    assert.equal(classifyDoorOperation("SINGLE_SWING_RIGHT"), "swing_right");
    assert.equal(classifyDoorOperation("single_swing_left"), "swing_left");
  });

  it("classifies double-swing (both-ways) single-leaf doors", () => {
    assert.equal(classifyDoorOperation("DOUBLE_SWING_LEFT"), "swing_left");
    assert.equal(classifyDoorOperation("DOUBLE_SWING_RIGHT"), "swing_right");
  });

  it("classifies sliding doors regardless of leaf count", () => {
    assert.equal(classifyDoorOperation("SLIDING_TO_LEFT"), "sliding");
    assert.equal(classifyDoorOperation("SLIDING_TO_RIGHT"), "sliding");
    assert.equal(classifyDoorOperation("DOUBLE_DOOR_SLIDING"), "sliding");
  });

  it("classifies the two-leaf double swing door", () => {
    assert.equal(classifyDoorOperation("DOUBLE_DOOR_DOUBLE_SWING"), "double_swing");
  });

  it("falls back to null for operation types it does not confidently model", () => {
    assert.equal(classifyDoorOperation("DOUBLE_DOOR_SINGLE_SWING"), null);
    assert.equal(classifyDoorOperation("DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_LEFT"), null);
    assert.equal(classifyDoorOperation("FOLDING_TO_LEFT"), null);
    assert.equal(classifyDoorOperation("REVOLVING"), null);
    assert.equal(classifyDoorOperation("USERDEFINED"), null);
  });
});

describe("buildDoorGlyph", () => {
  // Door opening along X from (0,0) to (2,0); normal +Y.
  const segment: [{ x: number; y: number }, { x: number; y: number }] = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
  ];
  const normal = { x: 0, y: 1 };

  it("returns null for unmodeled operation types", () => {
    assert.equal(buildDoorGlyph(segment, normal, "FOLDING_TO_LEFT"), null);
    assert.equal(buildDoorGlyph(segment, normal, null), null);
  });

  it("returns null for a degenerate (zero-length) segment", () => {
    assert.equal(
      buildDoorGlyph(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        normal,
        "SINGLE_SWING_LEFT",
      ),
      null,
    );
  });

  it("hinges a left-swing door at segment[0], leaf opening toward +normal", () => {
    const glyph = buildDoorGlyph(segment, normal, "SINGLE_SWING_LEFT");
    assert.ok(glyph);
    assert.equal(glyph!.kind, "swing_left");
    assert.equal(glyph!.leaves.length, 1);
    assert.equal(glyph!.arcs.length, 1);

    const leafPts = parsePoints(glyph!.leaves[0]!);
    assert.deepEqual(leafPts[0], { x: 0, y: 0 });
    assert.ok(Math.abs(leafPts[1]!.x - 0) < 1e-9 && Math.abs(leafPts[1]!.y - 2) < 1e-9);

    const arcPts = parsePoints(glyph!.arcs[0]!);
    assert.ok(Math.abs(arcPts[0]!.x - 0) < 1e-9 && Math.abs(arcPts[0]!.y - 2) < 1e-9);
    const last = arcPts[arcPts.length - 1]!;
    assert.ok(Math.abs(last.x - 2) < 1e-6 && Math.abs(last.y - 0) < 1e-6);
    for (const p of arcPts) {
      assert.ok(Math.abs(Math.hypot(p.x, p.y) - 2) < 1e-9, "arc point stays at hinge radius");
    }
  });

  it("hinges a right-swing door at segment[1]", () => {
    const glyph = buildDoorGlyph(segment, normal, "SINGLE_SWING_RIGHT");
    assert.ok(glyph);
    assert.equal(glyph!.kind, "swing_right");
    const leafPts = parsePoints(glyph!.leaves[0]!);
    assert.deepEqual(leafPts[0], { x: 2, y: 0 });
    assert.ok(Math.abs(leafPts[1]!.x - 2) < 1e-9 && Math.abs(leafPts[1]!.y - 2) < 1e-9);

    const arcPts = parsePoints(glyph!.arcs[0]!);
    const last = arcPts[arcPts.length - 1]!;
    assert.ok(Math.abs(last.x - 0) < 1e-6 && Math.abs(last.y - 0) < 1e-6);
  });

  it("draws a two-line sliding symbol offset toward +normal, no arcs", () => {
    const glyph = buildDoorGlyph(segment, normal, "SLIDING_TO_LEFT");
    assert.ok(glyph);
    assert.equal(glyph!.kind, "sliding");
    assert.equal(glyph!.leaves.length, 2);
    assert.equal(glyph!.arcs.length, 0);
    const offsetLine = parsePoints(glyph!.leaves[1]!);
    assert.ok(offsetLine[0]!.y > 0);
  });

  it("draws two hinged leaves meeting at the midpoint for a double swing door", () => {
    const glyph = buildDoorGlyph(segment, normal, "DOUBLE_DOOR_DOUBLE_SWING");
    assert.ok(glyph);
    assert.equal(glyph!.kind, "double_swing");
    assert.equal(glyph!.leaves.length, 2);
    assert.equal(glyph!.arcs.length, 2);

    const leafA = parsePoints(glyph!.leaves[0]!);
    assert.deepEqual(leafA[0], { x: 0, y: 0 });
    assert.ok(Math.abs(leafA[1]!.x - 0) < 1e-9 && Math.abs(leafA[1]!.y - 1) < 1e-9);

    const arcA = parsePoints(glyph!.arcs[0]!);
    const lastA = arcA[arcA.length - 1]!;
    assert.ok(Math.abs(lastA.x - 1) < 1e-6 && Math.abs(lastA.y - 0) < 1e-6);
  });
});
