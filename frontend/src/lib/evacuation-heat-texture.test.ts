import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeHeatField, type HeatSample } from "./evacuation-heat-texture.ts";

/**
 * Brute-force reference: checks every sample against every pixel, no
 * spatial hashing. Used only to cross-check computeHeatField's grid-binned
 * implementation — the exact class of bug a spatial-hash optimization can
 * introduce (a sample silently dropped near a cell boundary) would show up
 * as a mismatch here and nowhere else, since both implementations would
 * otherwise "look plausible" in isolation.
 */
function computeHeatFieldBruteForce(samples: HeatSample[], width: number, height: number, sigma: number) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const value = new Float32Array(w * h);
  const coverage = new Float32Array(w * h);
  if (samples.length === 0 || sigma <= 0) return { width: w, height: h, value, coverage };
  const twoSigmaSq = 2 * sigma * sigma;
  const cutoffSq = (sigma * 3) ** 2;
  const fullCoverageWeight = 1.1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sumWeight = 0;
      let sumWeightedValue = 0;
      for (const s of samples) {
        const dx = x - s.x;
        const dy = y - s.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > cutoffSq) continue;
        const weight = Math.exp(-distSq / twoSigmaSq);
        const v = Math.max(0, Math.min(1, s.value));
        sumWeight += weight;
        sumWeightedValue += weight * v;
      }
      if (sumWeight < 1e-4) continue;
      const idx = y * w + x;
      value[idx] = sumWeightedValue / sumWeight;
      coverage[idx] = Math.min(1, sumWeight / fullCoverageWeight);
    }
  }
  return { width: w, height: h, value, coverage };
}

describe("computeHeatField", () => {
  it("returns an all-zero field for no samples, without crashing", () => {
    const field = computeHeatField([], 10, 10, 5);
    assert.equal(field.width, 10);
    assert.equal(field.height, 10);
    assert.ok(field.coverage.every((c) => c === 0));
  });

  it("makes a low value clearly visible, not near-transparent — the bug this file replaced", () => {
    // A single isolated "safe" (low-value) sample: coverage at its own
    // center must be high (this was the actual reported bug — the old
    // alpha-encodes-value design made low values read as almost
    // transparent, indistinguishable from "no data here").
    const field = computeHeatField([{ x: 10, y: 10, value: 0.1 }], 20, 20, 4);
    const centerIdx = 10 * 20 + 10;
    assert.ok(field.coverage[centerIdx]! > 0.8, `expected high coverage at the sample itself, got ${field.coverage[centerIdx]}`);
    assert.ok(
      Math.abs(field.value[centerIdx]! - 0.1) < 1e-6,
      `expected the low value to still read as 0.1, got ${field.value[centerIdx]}`,
    );
  });

  it("fades to zero coverage far from every sample", () => {
    const field = computeHeatField([{ x: 5, y: 5, value: 0.5 }], 50, 50, 3);
    const farIdx = 45 * 50 + 45;
    assert.ok(field.coverage[farIdx]! < 0.01, `expected ~0 coverage far away, got ${field.coverage[farIdx]}`);
  });

  it("keeps the same value (not doubled) when two samples share a value and overlap", () => {
    const field = computeHeatField(
      [
        { x: 10, y: 10, value: 0.4 },
        { x: 11, y: 10, value: 0.4 },
      ],
      20,
      20,
      4,
    );
    const idx = 10 * 20 + 10;
    assert.ok(Math.abs(field.value[idx]! - 0.4) < 1e-6, `expected 0.4, got ${field.value[idx]}`);
    // Two overlapping same-value samples should read *more confidently*
    // covered than a single one at the same spot, not the same.
    const single = computeHeatField([{ x: 10, y: 10, value: 0.4 }], 20, 20, 4);
    assert.ok(field.coverage[idx]! > single.coverage[idx]!);
  });

  it("blends smoothly between a low and a high sample instead of hard-cutting", () => {
    // Symmetric midpoint between a green (0) and a red (1) sample should
    // land near the middle of the scale, not near either endpoint.
    const field = computeHeatField(
      [
        { x: 0, y: 10, value: 0 },
        { x: 20, y: 10, value: 1 },
      ],
      21,
      20,
      8,
    );
    const midIdx = 10 * 21 + 10;
    assert.ok(field.coverage[midIdx]! > 0, "midpoint should have some coverage from both samples");
    assert.ok(
      field.value[midIdx]! > 0.3 && field.value[midIdx]! < 0.7,
      `expected a blended mid-scale value at the midpoint, got ${field.value[midIdx]}`,
    );
  });

  it("clamps out-of-range sample values into 0..1", () => {
    const field = computeHeatField([{ x: 5, y: 5, value: 5 }], 10, 10, 3);
    const idx = 5 * 10 + 5;
    assert.ok(field.value[idx]! <= 1, `expected clamped value <= 1, got ${field.value[idx]}`);
    const field2 = computeHeatField([{ x: 5, y: 5, value: -3 }], 10, 10, 3);
    assert.ok(field2.value[idx]! >= 0, `expected clamped value >= 0, got ${field2.value[idx]}`);
  });

  it("handles sigma <= 0 without crashing", () => {
    const field = computeHeatField([{ x: 5, y: 5, value: 0.5 }], 10, 10, 0);
    assert.ok(field.coverage.every((c) => c === 0));
  });

  it("matches a brute-force (non-grid) reference implementation pixel-for-pixel", () => {
    // The grid-binning optimization only checks a pixel's own 3x3
    // neighborhood of cutoff-sized cells — the exact place a sample could
    // be silently excluded is when it sits very close to a cell boundary.
    // Deliberately seed several samples exactly on/near likely cell edges
    // (sigma=5 -> cutoff=15 -> cellSize=15) in addition to random ones.
    const samples: HeatSample[] = [
      { x: 15, y: 15, value: 0.2 }, // exactly on a cell corner
      { x: 14.999, y: 30.001, value: 0.9 }, // just inside/outside adjacent cells
      { x: 45, y: 0, value: 0.5 },
      { x: 0, y: 45, value: 0.7 },
      { x: 60, y: 60, value: 1 },
    ];
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 40; i++) {
      samples.push({ x: rand() * 70, y: rand() * 70, value: rand() });
    }

    const w = 70;
    const h = 70;
    const sigma = 5;
    const fast = computeHeatField(samples, w, h, sigma);
    const reference = computeHeatFieldBruteForce(samples, w, h, sigma);

    let worstValueDiff = 0;
    let worstCoverageDiff = 0;
    for (let i = 0; i < fast.coverage.length; i++) {
      worstCoverageDiff = Math.max(worstCoverageDiff, Math.abs(fast.coverage[i]! - reference.coverage[i]!));
      // Value is only meaningful where there's real coverage — where both
      // agree there's ~0 coverage, an uninitialized 0 vs a near-zero
      // division result can differ without it being a real bug.
      if (reference.coverage[i]! > 0.01) {
        worstValueDiff = Math.max(worstValueDiff, Math.abs(fast.value[i]! - reference.value[i]!));
      }
    }
    assert.ok(worstCoverageDiff < 1e-4, `grid-binned coverage diverged from brute force by ${worstCoverageDiff}`);
    assert.ok(worstValueDiff < 1e-4, `grid-binned value diverged from brute force by ${worstValueDiff}`);
  });
});
