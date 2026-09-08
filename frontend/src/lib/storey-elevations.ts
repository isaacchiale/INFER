/**
 * IFC Elevation is often millimetres while geom/fragments are metres.
 * Detect and scale so storey heights match the 3D model.
 *
 * Do NOT use total height span alone: a metre-scale survey building from sea
 * level to roof can span 50–80 m and is still metres. Floor-to-floor gaps are
 * the reliable signal (metres ≈ 2–6, millimetres ≈ 2000–6000).
 */
export function normalizeElevationsToMetres(
  elevs: number[],
  modelHeightM?: number,
): { scale: number; metres: number[] } {
  if (!elevs.length) return { scale: 1, metres: [] };
  const absMax = Math.max(...elevs.map((e) => Math.abs(e)));
  const sorted = [...elevs].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1]! - sorted[0]!;

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i]! - sorted[i - 1]!;
    if (g > 1e-9) gaps.push(g);
  }
  const typicalGap = gaps.length
    ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!
    : absMax;

  // Typical storey step ≫ 100 ⇒ mm. Absolute values in the thousands too.
  const looksLikeMm = typicalGap > 100 || absMax > 1000;
  // Also: span much larger than the 3D model height (mm vs metres mismatch).
  const vsModel =
    modelHeightM != null && modelHeightM > 0.5 && span > modelHeightM * 8;
  const scale = looksLikeMm || vsModel ? 0.001 : 1;
  return { scale, metres: elevs.map((e) => e * scale) };
}

/**
 * Elevations used to align Three Y with IFC storeys after COORDINATE_TO_ORIGIN.
 * Prefer storeys that actually have space footprints — "Sea Level" at 0 with no
 * geometry would otherwise pin the remap to the wrong datum and float/sink tubes.
 */
export function elevationsForVerticalRemap(
  storeysM: Array<{ global_id: string; elevation: number }>,
  spaceStoreyIds: Iterable<string | null | undefined>,
): number[] {
  const withSpaces = new Set<string>();
  for (const id of spaceStoreyIds) {
    if (id) withSpaces.add(id);
  }
  const filtered = storeysM
    .filter((s) => withSpaces.has(s.global_id))
    .map((s) => s.elevation);
  if (filtered.length) return filtered;
  return storeysM.map((s) => s.elevation);
}
