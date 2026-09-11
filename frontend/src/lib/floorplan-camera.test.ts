import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { smoothPolylinePathD } from "./floorplan-camera.ts";

describe("smoothPolylinePathD", () => {
  it("returns empty for fewer than 2 points", () => {
    assert.equal(smoothPolylinePathD([]), "");
    assert.equal(smoothPolylinePathD([{ x: 1, y: 1 }]), "");
  });

  it("draws a plain line for exactly 2 points (nothing to curve)", () => {
    const d = smoothPolylinePathD([
      { x: 0, y: 0 },
      { x: 4, y: 2 },
    ]);
    assert.equal(d, "M0 0 L4 2");
  });

  it("passes through every original point via cubic segments", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 2, y: 3 },
      { x: 5, y: 3 },
      { x: 7, y: 0 },
    ];
    const d = smoothPolylinePathD(points);
    assert.ok(d.startsWith("M0 0"));
    // One M + (n-1) cubic "C" segments, each ending at the next original point.
    const segments = d.split(" C");
    assert.equal(segments.length, points.length); // M + 3 "C" chunks
    for (let i = 1; i < points.length; i++) {
      const p = points[i]!;
      assert.ok(
        segments[i]!.trim().endsWith(`${p.x} ${p.y}`),
        `segment ${i} should end at ${p.x},${p.y}: ${segments[i]}`,
      );
    }
  });

  it("keeps a straight run of collinear points visually straight", () => {
    // Control points derived from collinear neighbours land on the same
    // line (c1y/c2y arithmetic stays exactly 0), so every "C" chunk's y
    // coordinates match the shared y — the cubic degenerates to a straight
    // segment instead of bowing off the line.
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    const d = smoothPolylinePathD(points);
    const numbers = d
      .replace(/[MC]/g, "")
      .trim()
      .split(/\s+/)
      .map(Number);
    // Every other number starting at index 1 is a y coordinate (x y x y ...).
    for (let i = 1; i < numbers.length; i += 2) {
      assert.equal(numbers[i], 0, `expected y=0 at index ${i}, got ${numbers[i]} in "${d}"`);
    }
  });
});
