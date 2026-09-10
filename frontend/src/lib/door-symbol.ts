/**
 * Architectural door glyphs (leaf + swing arc, or sliding double-line) built
 * from IfcDoor plan geometry + the raw IfcDoorTypeOperationEnum value.
 *
 * Deliberately conservative: only renders a swing/sliding glyph when the
 * source IFC actually classifies the operation type. A door with no
 * OperationType (or NOTDEFINED/USERDEFINED, or an operation type this module
 * doesn't confidently model — e.g. double-door single-swing, folding,
 * revolving) returns null so the caller keeps its existing dot/rectangle
 * fallback. Guessing swing side or drawing an arc for what might actually be
 * a sliding door would misrepresent the building, which is worse than the
 * neutral fallback.
 */

import type { Point2D } from "@/types/footprints";

export type DoorSymbolKind = "swing_left" | "swing_right" | "double_swing" | "sliding";

/** Classify a raw IfcDoorTypeOperationEnum value, or null when not confidently modeled. */
export function classifyDoorOperation(
  operationType: string | null | undefined,
): DoorSymbolKind | null {
  if (!operationType) return null;
  const v = operationType.toUpperCase();
  if (v.includes("SLIDING")) return "sliding";
  if (v === "DOUBLE_DOOR_DOUBLE_SWING") return "double_swing";
  if (v === "SINGLE_SWING_LEFT" || v === "DOUBLE_SWING_LEFT") return "swing_left";
  if (v === "SINGLE_SWING_RIGHT" || v === "DOUBLE_SWING_RIGHT") return "swing_right";
  // DOUBLE_DOOR_SINGLE_SWING(_OPPOSITE_LEFT/RIGHT), FOLDING_*, REVOLVING,
  // ROLLINGUP, USERDEFINED: not modeled — fall back rather than guess.
  return null;
}

export type DoorGlyph = {
  kind: DoorSymbolKind;
  /** Leaf line(s), drawn open (closed-position line is the door's own `segment`). */
  leaves: string[];
  /** Quarter-circle swing sweep(s), open tip → jamb. Empty for sliding. */
  arcs: string[];
};

/** Polyline approximation of the arc from `hinge`, sweeping the shorter way from `fromPt` to `toPt`. */
function swingArcPath(hinge: Point2D, fromPt: Point2D, toPt: Point2D, steps = 12): string {
  const radius = Math.hypot(fromPt.x - hinge.x, fromPt.y - hinge.y);
  if (radius < 1e-9) return "";
  const a0 = Math.atan2(fromPt.y - hinge.y, fromPt.x - hinge.x);
  const a1 = Math.atan2(toPt.y - hinge.y, toPt.x - hinge.x);
  let delta = a1 - a0;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const points: Point2D[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + (delta * i) / steps;
    points.push({ x: hinge.x + radius * Math.cos(t), y: hinge.y + radius * Math.sin(t) });
  }
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
}

/**
 * Build the leaf/arc path data for one door, in the same plan XY the rest of
 * the floorplan already draws in. Returns null when the operation type isn't
 * one of the shapes this module confidently draws (caller should fall back).
 *
 * `segment[0]` is treated as the left jamb and `segment[1]` as the right
 * jamb when facing through the doorway along `normal` — this follows directly
 * from how the backend derives `normal` as a 90° CCW rotation of the
 * segment's own direction (footprints.py's `_orientation_from_hull`), so it's
 * self-consistent per door, not a claim about which real-world side the IFC
 * author meant by "left"/"right".
 *
 * Swing direction always opens toward `+normal`. Which physical side (which
 * room) that actually is isn't derivable from the data extracted today — see
 * DoorPortal.operation_type's docstring — so this doesn't attempt to guess it.
 */
export function buildDoorGlyph(
  segment: readonly [Point2D, Point2D],
  normal: Point2D,
  operationType: string | null | undefined,
): DoorGlyph | null {
  const kind = classifyDoorOperation(operationType);
  if (!kind) return null;
  const [p0, p1] = segment;
  const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (length < 1e-6) return null;

  if (kind === "sliding") {
    const offset = Math.min(length * 0.08, 0.08);
    const a = { x: p0.x + normal.x * offset, y: p0.y + normal.y * offset };
    const b = { x: p1.x + normal.x * offset, y: p1.y + normal.y * offset };
    return {
      kind,
      leaves: [`M${p0.x} ${p0.y} L${p1.x} ${p1.y}`, `M${a.x} ${a.y} L${b.x} ${b.y}`],
      arcs: [],
    };
  }

  if (kind === "double_swing") {
    const half = length / 2;
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const tipA = { x: p0.x + normal.x * half, y: p0.y + normal.y * half };
    const tipB = { x: p1.x + normal.x * half, y: p1.y + normal.y * half };
    return {
      kind,
      leaves: [`M${p0.x} ${p0.y} L${tipA.x} ${tipA.y}`, `M${p1.x} ${p1.y} L${tipB.x} ${tipB.y}`],
      arcs: [swingArcPath(p0, tipA, mid), swingArcPath(p1, tipB, mid)],
    };
  }

  // Single swing: hinge at the left jamb (segment[0]) or right jamb (segment[1]).
  const hinge = kind === "swing_left" ? p0 : p1;
  const jamb = kind === "swing_left" ? p1 : p0;
  const tip = { x: hinge.x + normal.x * length, y: hinge.y + normal.y * length };
  return {
    kind,
    leaves: [`M${hinge.x} ${hinge.y} L${tip.x} ${tip.y}`],
    arcs: [swingArcPath(hinge, tip, jamb)],
  };
}
