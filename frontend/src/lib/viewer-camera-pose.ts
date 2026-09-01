/**
 * Map That Open / Three.js camera (Y-up) → IFC plan XY + elevation (metres).
 *
 * web-ifc / Fragments: (ifc.x, ifc.y, ifc.z) → (three.x, three.y=ifc.z, three.z=-ifc.y)
 * with an optional COORDINATE_TO_ORIGIN matrix applied on top.
 *
 * Prefer undoing the Fragments coordination matrix (exact origin shift). Fall back
 * to a centre translation only when that matrix is unavailable.
 */
export type ViewerCameraPose = {
  /** Three.js eye / feet (Y-up metres). */
  three: { x: number; y: number; z: number };
  /** IFC plan X (metres) — best-effort without coordination undo. */
  x: number;
  /** IFC plan Y (metres). */
  y: number;
  /** Height (Three Y ≈ IFC Z). */
  elevation: number;
};

/** Raw Three.js camera eye (Y-up). */
export type ThreeCameraPosition = { x: number; y: number; z: number };

export type PlanBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

/** Three.js world AABB (Y-up). */
export type ThreeAabb = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type PlanPose = { x: number; y: number; elevation: number };

/** Column-major 4×4 (Three.js / WebGL layout). */
export type Mat4Elements = number[];

/** Fixed web-ifc Y-up inverse (no coordination undo). */
export function threeToIfcPlan(pos: ThreeCameraPosition): PlanPose {
  return {
    x: pos.x,
    y: -pos.z,
    elevation: pos.y,
  };
}

export function threePositionToPlanPose(pos: ThreeCameraPosition): ViewerCameraPose {
  const plan = threeToIfcPlan(pos);
  return {
    three: { x: pos.x, y: pos.y, z: pos.z },
    x: plan.x,
    y: plan.y,
    elevation: plan.elevation,
  };
}

export function threeAabbCentre(box: ThreeAabb): ThreeCameraPosition {
  return {
    x: 0.5 * (box.minX + box.maxX),
    y: 0.5 * (box.minY + box.maxY),
    z: 0.5 * (box.minZ + box.maxZ),
  };
}

/** Apply column-major mat4 to a point (w=1). */
export function applyMat4Point(
  pos: ThreeCameraPosition,
  m: Mat4Elements,
): ThreeCameraPosition {
  const x = m[0]! * pos.x + m[4]! * pos.y + m[8]! * pos.z + m[12]!;
  const y = m[1]! * pos.x + m[5]! * pos.y + m[9]! * pos.z + m[13]!;
  const z = m[2]! * pos.x + m[6]! * pos.y + m[10]! * pos.z + m[14]!;
  return { x, y, z };
}

/**
 * After undoing coordination, interpret as IFC plan.
 * Large |Y| with small |Z| ⇒ Z-up IFC (x,y). Otherwise Y-up (x,-z).
 */
export function coordinatedToIfcPlan(pos: ThreeCameraPosition): PlanPose {
  const absY = Math.abs(pos.y);
  const absZ = Math.abs(pos.z);
  if (absY > absZ && absY > 50) {
    return { x: pos.x, y: pos.y, elevation: pos.z };
  }
  return threeToIfcPlan(pos);
}

/**
 * Camera Three position → IFC plan using the inverse coordination matrix when
 * available; otherwise the plain web-ifc map (+ optional centre delta).
 */
export function threeToIfcPlanResolved(
  pos: ThreeCameraPosition,
  coordInverse: Mat4Elements | null,
  centreDelta: { x: number; y: number } | null,
): PlanPose {
  if (coordInverse && coordInverse.length >= 16) {
    return coordinatedToIfcPlan(applyMat4Point(pos, coordInverse));
  }
  const plan = threeToIfcPlan(pos);
  if (!centreDelta) return plan;
  return {
    x: plan.x + centreDelta.x,
    y: plan.y + centreDelta.y,
    elevation: plan.elevation,
  };
}

/**
 * Translation that maps the Three model centre onto the footprint centre
 * under the fixed web-ifc plan map (fallback when no coordination matrix).
 */
export function planTranslationFromCentres(
  threeCentre: ThreeCameraPosition,
  footprintBounds: PlanBounds,
): { x: number; y: number } {
  const mapped = threeToIfcPlan(threeCentre);
  const fx = 0.5 * (footprintBounds.minX + footprintBounds.maxX);
  const fy = 0.5 * (footprintBounds.minY + footprintBounds.maxY);
  return { x: fx - mapped.x, y: fy - mapped.y };
}

export function applyPlanTranslation(
  plan: PlanPose,
  delta: { x: number; y: number } | null,
): PlanPose {
  if (!delta) return plan;
  return {
    x: plan.x + delta.x,
    y: plan.y + delta.y,
    elevation: plan.elevation,
  };
}

/**
 * Map Three Y (after COORDINATE_TO_ORIGIN) onto IFC storey elevations.
 * Aligns the model AABB floor with the lowest storey elevation.
 */
export function ifcElevationFromThree(
  threeY: number,
  modelBounds: ThreeAabb | null,
  storeyElevationsM: number[],
): number {
  if (!modelBounds || !storeyElevationsM.length) return threeY;
  const minStorey = Math.min(...storeyElevationsM);
  return threeY + (minStorey - modelBounds.minY);
}

/**
 * Pick the storey whose vertical band contains `elevation`.
 * Band = [thisElev, nextElev) with a default storey height for the top floor.
 */
export function storeyIdForElevation(
  storeys: Array<{ global_id: string; elevation: number | null }>,
  elevation: number,
  defaultStoreyHeightM = 3.5,
): string | null {
  const ranked = storeys
    .map((s) => ({
      global_id: s.global_id,
      elev: s.elevation == null || !Number.isFinite(s.elevation) ? null : s.elevation,
    }))
    .filter((s): s is { global_id: string; elev: number } => s.elev != null)
    .sort((a, b) => a.elev - b.elev);

  if (!ranked.length) return null;

  for (let i = 0; i < ranked.length; i++) {
    const lo = ranked[i]!.elev;
    const hi =
      i + 1 < ranked.length
        ? ranked[i + 1]!.elev
        : lo + defaultStoreyHeightM;
    if (elevation >= lo - 0.35 && elevation < hi) {
      return ranked[i]!.global_id;
    }
  }

  let best: { id: string; d: number } | null = null;
  for (const s of ranked) {
    const d = Math.abs(elevation - s.elev);
    if (!best || d < best.d) best = { id: s.global_id, d };
  }
  if (best && best.d <= defaultStoreyHeightM * 0.6) return best.id;
  return null;
}

export function pointInBuildingBounds(
  x: number,
  y: number,
  bounds: PlanBounds | null,
  marginM = 2,
): boolean {
  if (!bounds) return false;
  return (
    x >= bounds.minX - marginM &&
    x <= bounds.maxX + marginM &&
    y >= bounds.minY - marginM &&
    y <= bounds.maxY + marginM
  );
}
