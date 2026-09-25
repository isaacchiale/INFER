/**
 * Shared Okabe–Ito legend hexes — mirrors `styles.css` tokens for canvases
 * that cannot read CSS variables (Cytoscape, Three.js). Keep in sync with
 * `--portal-*`, `--stair-glyph`, `--selection`, `--route-normal`.
 */
export const LEGEND = {
  /** Authored IFC door (floorplan portal + graph IFC edge) — muted amber. */
  ifcDoor: "#F59E0B",
  /** Geometry door heal — Okabe pink/magenta (distinct from amber). */
  doorHeal: "#CC79A7",
  /** Space↔space opening heal. */
  spaceHeal: "#22C55E",
  /** Stair footprint / stair heal edge / stair graph node. */
  stair: "#7C3AED",
  /** Exterior exit portal. */
  exit: "#DC2626",
  /** Click-to-click / hop route (blue only for paths). */
  route: "#2563EB",
  routeSoft: "#60A5FA",
  /** Selected room / node fill (sky — not route blue). */
  selected: "#56B4E9",
  selectedFill: "#7DD3FC",
  /** Soft-removed / blocked. */
  disabled: "#94A3B8",
  /** Furniture — cream, so it recedes against blue path / sky selection. */
  furniture: "#F3E6C4",
} as const;
