import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { exportUSDZ } from "./export-usdz.ts";

describe("exportUSDZ", () => {
  it("exports a well-formed mesh (the only shape any real caller in this app ever hands it)", async () => {
    // Both real callers — buildExportGroup and buildRouteShareScene — only
    // ever construct fresh THREE.MeshStandardMaterial instances, never
    // fragments' own materials directly (that's the actual fix for the
    // earlier crashes here; see export-usdz.ts's doc comment). This test
    // just confirms the thin wrapper itself works, not defensive handling
    // of malformed input.
    const material = new THREE.MeshStandardMaterial({ color: 0x8899aa });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);

    const blob = await exportUSDZ(mesh);
    assert.ok(blob.size > 0);
    assert.equal(blob.type, "model/vnd.usdz+zip");
  });
});
