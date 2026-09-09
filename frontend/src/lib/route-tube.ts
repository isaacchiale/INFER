/**
 * Build Three.js world polylines for the route tube overlay (all storeys).
 * Pure: no Three / That Open imports.
 *
 * Placement is resolved ONCE per model from the whole-building footprint AABB —
 * never per route. Scoring individual routes made the tube jump between correct
 * and offset depending on which route was selected.
 *
 * Each storey with a usable path slice becomes its own polyline (own tube mesh).
 * No invented stair ramps — vertical hops stay as separate floor slices.
 */

import { continuousPolylineForStorey } from "@/lib/geometric-path";
import {
  elevationsForVerticalRemap,
  normalizeElevationsToMetres,
} from "@/lib/storey-elevations";
import {
  ifcPlanToThree,
  liftPlanPolylineToThree,
  planTranslationFromCentres,
  threeAabbCentre,
  type LiftPlanOptions,
  type Mat4Elements,
  type PlanBounds,
  type ThreeAabb,
  type ThreeCameraPosition,
} from "@/lib/viewer-camera-pose";
import type { FootprintsDocument } from "@/types/footprints";
import type { ConnectivityGraph, RouteResult } from "@/types/graph";

/** Height of tube centreline above slab (metres). */
export const ROUTE_TUBE_HEIGHT_OFFSET_M = 0.7;

function footprintPlanBounds(doc: FootprintsDocument): PlanBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  const push = (x: number, y: number) => {
    any = true;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const s of doc.spaces) {
    if (s.incomplete) continue;
    for (const p of s.polygon) push(p.x, p.y);
  }
  for (const d of doc.doors) {
    if (d.point && !d.incomplete) push(d.point.x, d.point.y);
  }
  for (const st of doc.stairs ?? []) {
    if (st.incomplete) continue;
    for (const p of st.polygon) push(p.x, p.y);
  }
  for (const w of doc.walls ?? []) {
    if (w.incomplete) continue;
    for (const p of w.polygon) push(p.x, p.y);
  }
  if (!any) return null;
  return { minX, maxX, minY, maxY };
}

function storeysMetres(
  doc: FootprintsDocument,
  modelHeightM?: number,
): Array<{ global_id: string; elevation: number }> {
  const raw = doc.storeys ?? [];
  const withElev = raw.filter(
    (s): s is { global_id: string; name: string; elevation: number } =>
      s.elevation != null && Number.isFinite(s.elevation),
  );
  if (!withElev.length) return [];
  const { metres } = normalizeElevationsToMetres(
    withElev.map((s) => s.elevation),
    modelHeightM,
  );
  return withElev.map((s, i) => ({
    global_id: s.global_id,
    elevation: metres[i]!,
  }));
}

function spaceStoreyIds(doc: FootprintsDocument): string[] {
  const ids: string[] = [];
  for (const s of doc.spaces) {
    if (s.incomplete || s.polygon.length < 3 || !s.storey_global_id) continue;
    ids.push(s.storey_global_id);
  }
  return ids;
}

export type BuildRouteTubeArgs = {
  route: RouteResult | null;
  footprints: FootprintsDocument | null;
  graph?: ConnectivityGraph | null;
  /**
   * @deprecated Ignored — 3D tube always draws every storey on the route.
   * Kept so call sites stay stable.
   */
  activeStoreyId?: string | "all";
  /** Fragments coordination inverse — preferred when it lands on the mesh. */
  coordInverse?: Mat4Elements | null;
  modelBounds?: ThreeAabb | null;
};

function isUsableCoordInverse(m: Mat4Elements | null | undefined): boolean {
  return Boolean(m && m.length >= 16);
}

function boxDiagonal(box: ThreeAabb): number {
  return Math.hypot(
    box.maxX - box.minX,
    box.maxY - box.minY,
    box.maxZ - box.minZ,
  );
}

/** Corners of the building plan AABB — the model-level probe. */
function planBoundsCorners(b: PlanBounds): Array<{ x: number; y: number }> {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

/**
 * Distance from the mapped building centre to the model AABB centre, ignoring
 * height. Infinity when the mapping produced non-finite coordinates.
 */
function probePlanDistance(
  pts: ThreeCameraPosition[],
  box: ThreeAabb,
): number {
  if (!pts.length) return Number.POSITIVE_INFINITY;
  let x = 0;
  let z = 0;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      return Number.POSITIVE_INFINITY;
    }
    x += p.x;
    z += p.z;
  }
  const cx = x / pts.length;
  const cz = z / pts.length;
  return Math.hypot(
    cx - 0.5 * (box.minX + box.maxX),
    cz - 0.5 * (box.minZ + box.maxZ),
  );
}

/**
 * Choose the plan→Three mapping for a model. Depends only on model-level inputs
 * (building footprint, model AABB, coordination matrix), so every route in the
 * model gets the same placement.
 */
export function resolveRouteTubeLiftOptions(args: {
  planBounds: PlanBounds;
  probeElevationM: number;
  modelBounds: ThreeAabb;
  storeyElevationsM: number[];
  coordInverse?: Mat4Elements | null;
}): LiftPlanOptions {
  const { planBounds, probeElevationM, modelBounds, storeyElevationsM } = args;
  const base: LiftPlanOptions = {
    heightOffsetM: ROUTE_TUBE_HEIGHT_OFFSET_M,
    modelBounds,
    storeyElevationsM,
  };
  const corners = planBoundsCorners(planBounds);
  const probe = (opts: LiftPlanOptions) =>
    corners.map((c) => ifcPlanToThree(c.x, c.y, probeElevationM, opts));

  const delta = planTranslationFromCentres(
    threeAabbCentre(modelBounds),
    planBounds,
  );
  const centreDeltaOpts: LiftPlanOptions = {
    ...base,
    centreDelta:
      Math.abs(delta.x) < 0.05 && Math.abs(delta.y) < 0.05
        ? { x: 0, y: 0 }
        : delta,
  };

  if (!isUsableCoordInverse(args.coordInverse)) return centreDeltaOpts;

  // Accept the matrix only if it lands the building on the mesh; a wrong packing
  // leaves survey-scale models hundreds of kilometres away.
  const tolerance = Math.max(boxDiagonal(modelBounds) * 0.5, 5);
  const matrixOpts: LiftPlanOptions[] = [
    { ...base, coordInverse: args.coordInverse },
    { ...base, coordInverse: args.coordInverse, forceYupUncoord: true },
  ];

  let best: LiftPlanOptions | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const opts of matrixOpts) {
    const distance = probePlanDistance(probe(opts), modelBounds);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = opts;
    }
  }

  return best && bestDistance <= tolerance ? best : centreDeltaOpts;
}

/**
 * One lifted polyline per storey that has a usable path slice on the route.
 * Floorplan storey selection does not filter this — the 3D tube shows the full
 * multi-floor path as separate per-storey tubes (no stair ramps).
 */
export function buildRouteTubePolylines(
  args: BuildRouteTubeArgs,
): ThreeCameraPosition[][] | null {
  const { route, footprints, graph, modelBounds, coordInverse } = args;

  if (!route?.node_ids?.length || !footprints || !modelBounds) {
    return null;
  }

  const planBounds = footprintPlanBounds(footprints);
  if (!planBounds) return null;

  const modelHeightM = modelBounds.maxY - modelBounds.minY;
  const metres = storeysMetres(footprints, modelHeightM);
  const storeyIds = [
    ...metres.map((s) => s.global_id),
    ...(footprints.storeys ?? []).map((s) => s.global_id),
  ];

  const storeyElevationsM = elevationsForVerticalRemap(
    metres,
    spaceStoreyIds(footprints),
  );
  const liftOpts = resolveRouteTubeLiftOptions({
    planBounds,
    probeElevationM: storeyElevationsM.length
      ? Math.min(...storeyElevationsM)
      : metres.length
        ? Math.min(...metres.map((s) => s.elevation))
        : 0,
    modelBounds,
    storeyElevationsM,
    coordInverse,
  });

  const seen = new Set<string>();
  const polylines: ThreeCameraPosition[][] = [];

  for (const id of storeyIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const line = continuousPolylineForStorey(
      route.node_ids,
      footprints,
      id,
      graph,
    );
    if (line.points.length < 2) continue;
    const elevation = metres.find((s) => s.global_id === id)?.elevation ?? 0;
    polylines.push(liftPlanPolylineToThree(line.points, elevation, liftOpts));
  }

  return polylines.length ? polylines : null;
}

/**
 * Lift a click-to-click plan polyline (one storey) into Three for the blue tube.
 */
export function buildPlanRouteTubePolylines(args: {
  points: Array<{ x: number; y: number }> | null | undefined;
  storeyId: string | null | undefined;
  footprints: FootprintsDocument | null;
  modelBounds?: ThreeAabb | null;
  coordInverse?: Mat4Elements | null;
}): ThreeCameraPosition[][] | null {
  const { points, storeyId, footprints, modelBounds, coordInverse } = args;
  if (!points || points.length < 2 || !storeyId || !footprints || !modelBounds) {
    return null;
  }

  const planBounds = footprintPlanBounds(footprints);
  if (!planBounds) return null;

  const modelHeightM = modelBounds.maxY - modelBounds.minY;
  const metres = storeysMetres(footprints, modelHeightM);
  const storeyElevationsM = elevationsForVerticalRemap(
    metres,
    spaceStoreyIds(footprints),
  );
  const liftOpts = resolveRouteTubeLiftOptions({
    planBounds,
    probeElevationM: storeyElevationsM.length
      ? Math.min(...storeyElevationsM)
      : metres.length
        ? Math.min(...metres.map((s) => s.elevation))
        : 0,
    modelBounds,
    storeyElevationsM,
    coordInverse,
  });

  const elevation = metres.find((s) => s.global_id === storeyId)?.elevation ?? 0;
  const lifted = liftPlanPolylineToThree(points, elevation, liftOpts);
  return lifted.length >= 2 ? [lifted] : null;
}

/**
 * @deprecated Prefer {@link buildRouteTubePolylines}. Returns the first storey
 * polyline only (legacy single-tube callers / tests).
 */
export function buildActiveStoreyRouteTubePoints(
  args: BuildRouteTubeArgs,
): ThreeCameraPosition[] | null {
  const all = buildRouteTubePolylines(args);
  return all?.[0] ?? null;
}
