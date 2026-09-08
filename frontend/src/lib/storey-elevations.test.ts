import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  elevationsForVerticalRemap,
  normalizeElevationsToMetres,
} from "./storey-elevations.ts";

describe("normalizeElevationsToMetres", () => {
  it("leaves metre elevations alone", () => {
    const { scale, metres } = normalizeElevationsToMetres([0, 3, 6, 9], 12);
    assert.equal(scale, 1);
    assert.deepEqual(metres, [0, 3, 6, 9]);
  });

  it("scales millimetre elevations to metres", () => {
    const { scale, metres } = normalizeElevationsToMetres(
      [-1000, 0, 3000, 6000, 9000, 12000],
      13,
    );
    assert.equal(scale, 0.001);
    assert.equal(metres[2], 3);
    assert.equal(metres[5], 12);
  });

  it("keeps survey-metre office towers (span > 50) as metres", () => {
    // NordicLCA-style: Sea Level ≈ 0 … Roof ≈ 78 m. Old span>50 heuristic
    // wrongly treated this as millimetres and crushed floors to ~0.08 m.
    const elevs = [0, 51, 51.7, 55.5, 58.9, 59.7, 63.72, 67.74, 72.305, 78.366];
    const { scale, metres } = normalizeElevationsToMetres(elevs, 30);
    assert.equal(scale, 1);
    assert.equal(metres[3], 55.5);
    assert.ok(Math.abs(metres[metres.length - 1]! - 78.366) < 1e-9);
  });
});

describe("elevationsForVerticalRemap", () => {
  it("drops datum storeys that have no spaces", () => {
    const storeys = [
      { global_id: "sea", elevation: 0 },
      { global_id: "found", elevation: 51 },
      { global_id: "l1", elevation: 55.5 },
    ];
    const elevs = elevationsForVerticalRemap(storeys, ["found", "l1", "l1"]);
    assert.deepEqual(elevs, [51, 55.5]);
    assert.equal(Math.min(...elevs), 51);
  });

  it("falls back to all storeys when no spaces match", () => {
    const storeys = [
      { global_id: "sea", elevation: 0 },
      { global_id: "l1", elevation: 3 },
    ];
    assert.deepEqual(elevationsForVerticalRemap(storeys, []), [0, 3]);
  });
});
