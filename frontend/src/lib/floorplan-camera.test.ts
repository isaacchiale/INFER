import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { smoothPolylinePathD } from "./floorplan-camera.ts";
import { localPathInPolygon, pointInPolygon } from "./geometric-path.ts";
import type { Point2D } from "../types/footprints.ts";

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

/** Sample the cubic-bezier "M x y C c1x c1y c2x c2y ex ey C ..." string densely. */
function sampleSmoothedPath(d: string, samplesPerSegment = 60): Point2D[] {
  const tokens = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  let i = 0;
  const start0 = { x: tokens[i++]!, y: tokens[i++]! };
  const segments: [Point2D, Point2D, Point2D, Point2D][] = [];
  let start = start0;
  while (i < tokens.length) {
    const c1 = { x: tokens[i++]!, y: tokens[i++]! };
    const c2 = { x: tokens[i++]!, y: tokens[i++]! };
    const end = { x: tokens[i++]!, y: tokens[i++]! };
    segments.push([start, c1, c2, end]);
    start = end;
  }
  const out: Point2D[] = [];
  for (const [p0, p1, p2, p3] of segments) {
    for (let s = 0; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const mt = 1 - t;
      out.push({
        x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
        y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
      });
    }
  }
  return out;
}

/**
 * The concern this guards: does smoothPolylinePathD's curve "cut the corner"
 * on a sharp A*-routed bend and dip into the obstacle the raw path was
 * routed around? A Catmull-Rom curve always passes exactly through every
 * original waypoint (each is a Bezier segment endpoint), but the curve
 * *between* waypoints is influenced by neighbouring tangents and could in
 * principle bow closer to an obstacle than the straight polyline did.
 * Densely samples the actual rendered curve against real A*-routed paths,
 * including two deliberately adversarial shapes (a narrow pinch between two
 * obstacles forcing a sharp reversal, and a staggered S-curve corridor).
 */
describe("smoothPolylinePathD does not cut into routed-around obstacles", () => {
  function assertNoIntrusion(
    room: Point2D[],
    obstacles: Point2D[][],
    start: Point2D,
    goal: Point2D,
  ) {
    const rawPath = localPathInPolygon(start, goal, room, undefined, obstacles);
    const insideAny = (p: Point2D) => obstacles.some((o) => pointInPolygon(p.x, p.y, o));
    assert.ok(
      !rawPath.some(insideAny),
      "test setup invalid: raw A* path already enters an obstacle",
    );

    const sampled = sampleSmoothedPath(smoothPolylinePathD(rawPath));
    const intrusions = sampled.filter(insideAny);
    assert.equal(
      intrusions.length,
      0,
      `smoothed curve cut into an obstacle at ${JSON.stringify(intrusions.slice(0, 3))}`,
    );
  }

  it("desk blocking a straight corridor route", () => {
    assertNoIntrusion(
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ],
      [
        [
          { x: 9.7, y: 2 },
          { x: 10.3, y: 2 },
          { x: 10.3, y: 9.5 },
          { x: 9.7, y: 9.5 },
        ],
      ],
      { x: 2, y: 5 },
      { x: 18, y: 5 },
    );
  });

  it("narrow pinch between two desks with a sharp reversal", () => {
    assertNoIntrusion(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      [
        [
          { x: 4, y: 0 },
          { x: 4.7, y: 0 },
          { x: 4.7, y: 4.6 },
          { x: 4, y: 4.6 },
        ],
        [
          { x: 5.3, y: 5.4 },
          { x: 6, y: 5.4 },
          { x: 6, y: 10 },
          { x: 5.3, y: 10 },
        ],
      ],
      { x: 1, y: 5 },
      { x: 9, y: 5 },
    );
  });

  it("S-curve between staggered desks", () => {
    assertNoIntrusion(
      [
        { x: 0, y: 0 },
        { x: 14, y: 0 },
        { x: 14, y: 6 },
        { x: 0, y: 6 },
      ],
      [
        [
          { x: 2, y: 1.5 },
          { x: 4, y: 1.5 },
          { x: 4, y: 6 },
          { x: 2, y: 6 },
        ],
        [
          { x: 6, y: 0 },
          { x: 8, y: 0 },
          { x: 8, y: 4.5 },
          { x: 6, y: 4.5 },
        ],
        [
          { x: 10, y: 1.5 },
          { x: 12, y: 1.5 },
          { x: 12, y: 6 },
          { x: 10, y: 6 },
        ],
      ],
      { x: 0.5, y: 3 },
      { x: 13.5, y: 3 },
    );
  });
});
