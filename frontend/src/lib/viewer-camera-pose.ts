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
  /** Camera look direction in Three.js world (unit-ish). */
  forward: { x: number; y: number; z: number };
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

export function threePositionToPlanPose(
  pos: ThreeCameraPosition,
  forward: ThreeCameraPosition = { x: 0, y: 0, z: -1 },
): ViewerCameraPose {
  const plan = threeToIfcPlan(pos);
  const fl = Math.hypot(forward.x, forward.y, forward.z) || 1;
  return {
    three: { x: pos.x, y: pos.y, z: pos.z },
    x: plan.x,
    y: plan.y,
    elevation: plan.elevation,
    forward: {
      x: forward.x / fl,
      y: forward.y / fl,
      z: forward.z / fl,
    },
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

/** How to read coordinates after undoing coordination. */
export type CoordAxisFrame = "zup" | "yup";

/** Z-up reading of undone coords: IFC (x, y) with height z. */
function zupPlan(pos: ThreeCameraPosition): PlanPose {
  return { x: pos.x, y: pos.y, elevation: pos.z };
}

/**
 * After undoing coordination, interpret as IFC plan.
 *
 * Pass an explicit `frame` whenever possible: the magnitude heuristic below is
 * evaluated per point, so a camera walking across a building can cross the
 * |Y| vs |Z| threshold mid-walk and flip interpretation, which teleports the
 * plan dot and its elevation. Callers should resolve the frame once per model
 * with {@link resolveCoordAxisFrame}.
 */
export function coordinatedToIfcPlan(
  pos: ThreeCameraPosition,
  frame?: CoordAxisFrame,
): PlanPose {
  if (frame === "zup") return zupPlan(pos);
  if (frame === "yup") return threeToIfcPlan(pos);
  const absY = Math.abs(pos.y);
  const absZ = Math.abs(pos.z);
  if (absY > absZ && absY > 50) return zupPlan(pos);
  return threeToIfcPlan(pos);
}

/**
 * Decide once per model how to read coordinates undone by the coordination
 * matrix. Probes the model AABB centre and keeps the reading whose plan XY
 * lands closest to the footprint centre.
 */
export function resolveCoordAxisFrame(
  coordInverse: Mat4Elements | null,
  modelBounds: ThreeAabb | null,
  footprintBounds: PlanBounds | null,
): CoordAxisFrame {
  if (!coordInverse || coordInverse.length < 16 || !modelBounds || !footprintBounds) {
    return "yup";
  }
  const probe = applyMat4Point(threeAabbCentre(modelBounds), coordInverse);
  const fx = 0.5 * (footprintBounds.minX + footprintBounds.maxX);
  const fy = 0.5 * (footprintBounds.minY + footprintBounds.maxY);
  const score = (p: PlanPose) =>
    Number.isFinite(p.x) && Number.isFinite(p.y)
      ? Math.hypot(p.x - fx, p.y - fy)
      : Number.POSITIVE_INFINITY;
  return score(zupPlan(probe)) <= score(threeToIfcPlan(probe)) ? "zup" : "yup";
}

/**
 * Camera Three position → IFC plan using the inverse coordination matrix when
 * available; otherwise the plain web-ifc map (+ optional centre delta).
 */
export function threeToIfcPlanResolved(
  pos: ThreeCameraPosition,
  coordInverse: Mat4Elements | null,
  centreDelta: { x: number; y: number } | null,
  frame?: CoordAxisFrame,
): PlanPose {
  if (coordInverse && coordInverse.length >= 16) {
    return coordinatedToIfcPlan(applyMat4Point(pos, coordInverse), frame);
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
 * Plan heading (radians, Y-up): 0 = +X, increases toward +Y.
 * Maps a Three look direction with the same plan transform as the camera dot.
 */
export function planHeadingFromThree(
  eye: ThreeCameraPosition,
  forward: ThreeCameraPosition,
  coordInverse: Mat4Elements | null,
  centreDelta: { x: number; y: number } | null,
  frame?: CoordAxisFrame,
): number {
  const fl = Math.hypot(forward.x, forward.y, forward.z) || 1;
  const tip: ThreeCameraPosition = {
    x: eye.x + forward.x / fl,
    y: eye.y + forward.y / fl,
    z: eye.z + forward.z / fl,
  };
  const a = threeToIfcPlanResolved(eye, coordInverse, centreDelta, frame);
  const b = threeToIfcPlanResolved(tip, coordInverse, centreDelta, frame);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx * dx + dy * dy < 1e-16) return 0;
  return Math.atan2(dy, dx);
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

/** Invert a column-major 4×4 (affine). Returns null if singular. */
export function invertMat4(m: Mat4Elements): Mat4Elements | null {
  if (m.length < 16) return null;
  const out = new Array<number>(16);
  // Gl-matrix style invert for mat4
  const a00 = m[0]!,
    a01 = m[1]!,
    a02 = m[2]!,
    a03 = m[3]!;
  const a10 = m[4]!,
    a11 = m[5]!,
    a12 = m[6]!,
    a13 = m[7]!;
  const a20 = m[8]!,
    a21 = m[9]!,
    a22 = m[10]!,
    a23 = m[11]!;
  const a30 = m[12]!,
    a31 = m[13]!,
    a32 = m[14]!,
    a33 = m[15]!;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return null;
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/**
 * Pack IFC plan XY + elevation into the pre-coordination Three frame
 * (inverse of coordinatedToIfcPlan / threeToIfcPlan).
 */
export function ifcPlanToUncoordinatedThree(
  x: number,
  y: number,
  elevation: number,
): ThreeCameraPosition {
  // Large survey XY ⇒ restored Z-up IFC (x,y,z=elev). Else web-ifc Y-up.
  if (Math.abs(x) > 50 && Math.abs(y) > 50) {
    return { x, y, z: elevation };
  }
  return { x, y: elevation, z: -y };
}

/** Inverse of ifcElevationFromThree: IFC storey elev → Three Y. */
export function threeYFromIfcElevation(
  ifcElevation: number,
  modelBounds: ThreeAabb | null,
  storeyElevationsM: number[],
): number {
  if (!modelBounds || !storeyElevationsM.length) return ifcElevation;
  const minStorey = Math.min(...storeyElevationsM);
  return ifcElevation - (minStorey - modelBounds.minY);
}

export type LiftPlanOptions = {
  /** Fragments coordination inverse (column-major). Prefer over centreDelta. */
  coordInverse?: Mat4Elements | null;
  /**
   * When set with coordInverse: pack as web-ifc Y-up `(x, elev, -y)` before the
   * forward matrix, instead of the survey Z-up heuristic. Some Fragments
   * matrices expect this even for georeferenced IFCs.
   */
  forceYupUncoord?: boolean;
  /** Fallback plan shift used by floorplan camera dot when no coordination. */
  centreDelta?: { x: number; y: number } | null;
  /** When set with modelBounds, remap storey elev onto Three Y (no-coord path). */
  modelBounds?: ThreeAabb | null;
  storeyElevationsM?: number[];
  /** Lift above the slab to reduce z-fighting (metres). */
  heightOffsetM?: number;
};

/**
 * IFC plan point → Three.js world (Y-up), matching camera↔floorplan mapping.
 */
export function ifcPlanToThree(
  x: number,
  y: number,
  elevation: number,
  options: LiftPlanOptions = {},
): ThreeCameraPosition {
  const eps = options.heightOffsetM ?? 0;
  const elev = elevation + eps;
  const hasCoord =
    Boolean(options.coordInverse) && (options.coordInverse?.length ?? 0) >= 16;

  if (hasCoord) {
    const uncoord = options.forceYupUncoord
      ? { x, y: elev, z: -y }
      : ifcPlanToUncoordinatedThree(x, y, elev);
    const forward = invertMat4(options.coordInverse!);
    if (forward) return applyMat4Point(uncoord, forward);
    return uncoord;
  }

  const delta = options.centreDelta;
  const threeY = threeYFromIfcElevation(
    elev,
    options.modelBounds ?? null,
    options.storeyElevationsM ?? [],
  );
  if (delta) {
    return {
      x: x - delta.x,
      y: threeY,
      z: -(y - delta.y),
    };
  }
  return { x, y: threeY, z: -y };
}

/** Lift a 2D floorplan polyline onto a storey elevation in Three space. */
export function liftPlanPolylineToThree(
  points: Array<{ x: number; y: number }>,
  storeyElevationM: number,
  options: LiftPlanOptions = {},
): ThreeCameraPosition[] {
  return points.map((p) =>
    ifcPlanToThree(p.x, p.y, storeyElevationM, options),
  );
}
