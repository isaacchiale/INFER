import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeElevationsToMetres } from "./storey-elevations.ts";

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
});
