/**
 * IFC Elevation is often millimetres while geom/fragments are metres.
 * Detect and scale so storey heights match the 3D model.
 */
export function normalizeElevationsToMetres(
  elevs: number[],
  modelHeightM?: number,
): { scale: number; metres: number[] } {
  if (!elevs.length) return { scale: 1, metres: [] };
  const absMax = Math.max(...elevs.map((e) => Math.abs(e)));
  const span = Math.max(...elevs) - Math.min(...elevs);
  // Storey spacing ≫ 50 or absolute ≫ 200 ⇒ almost certainly mm (or other non-metre).
  const looksLikeMm = span > 50 || absMax > 200;
  // Also: span much larger than the 3D model height.
  const vsModel =
    modelHeightM != null && modelHeightM > 0.5 && span > modelHeightM * 8;
  const scale = looksLikeMm || vsModel ? 0.001 : 1;
  return { scale, metres: elevs.map((e) => e * scale) };
}
