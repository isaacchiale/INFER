/**
 * Pure plan-view camera math for FloorplanViewer: the world↔screen mapping,
 * pan/zoom state shape, and viewBox helpers. No React, no DOM — the pointer/
 * wheel event wiring that drives these stays in FloorplanViewer.tsx since it
 * also owns navmesh pin placement on the same surface.
 */

export type PlanView = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type Point2 = { x: number; y: number };

export type Camera = {
  /** World-space pan (applied after Y-flip, in the same XY as footprints). */
  panX: number;
  panY: number;
  /** 1 = fit to building bounds. */
  zoom: number;
};

export const IDENTITY_CAMERA: Camera = { panX: 0, panY: 0, zoom: 1 };

export function viewWidth(v: PlanView) {
  return Math.max(v.maxX - v.minX, 1e-6);
}
export function viewHeight(v: PlanView) {
  return Math.max(v.maxY - v.minY, 1e-6);
}

export function toViewBox(v: PlanView) {
  // SVG Y grows down; world Y grows up — flip via negative Y origin on the root viewBox.
  return `${v.minX} ${-v.maxY} ${viewWidth(v)} ${viewHeight(v)}`;
}

/**
 * Smooth an ordered polyline into a Catmull-Rom-through-cubic-Bezier SVG path
 * (uniform parametrization, tension 1/6, clamped end tangents by duplicating
 * the first/last point). A plain `M..L..L..` polyline shows every A*
 * waypoint as a hard corner; the 3D viewer draws the exact same route point
 * data through THREE.CatmullRomCurve3 for its tube, so without this the flat
 * 2D route reads as noticeably more jagged than 3D even though the
 * underlying path is identical (and already string-pulled — see
 * simplifyLocalPath in geometric-path.ts). Purely a display curve: the
 * points it interpolates between are unchanged, so it doesn't affect
 * anything but how the line is drawn.
 */
export function smoothPolylinePathD(points: Point2[]): string {
  const n = points.length;
  if (n < 2) return "";
  if (n === 2) return `M${points[0]!.x} ${points[0]!.y} L${points[1]!.x} ${points[1]!.y}`;
  const at = (i: number) => points[Math.max(0, Math.min(n - 1, i))]!;
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}

export function boundsFromPoints(points: Point2[], padRatio = 0.08): PlanView | null {
  if (!points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return null;
  const pad =
    padRatio <= 0
      ? 0
      : Math.max((maxX - minX) * padRatio, (maxY - minY) * padRatio, 0.5);
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

/**
 * Map a client pixel through the fixed building viewBox + camera transform
 * into footprint world XY (Y-up).
 */
export function clientToView(
  clientX: number,
  clientY: number,
  el: SVGSVGElement,
  bounds: PlanView,
  cam: Camera,
): Point2 {
  const rect = el.getBoundingClientRect();
  const w = Math.max(rect.width, 1);
  const h = Math.max(rect.height, 1);
  const vw = viewWidth(bounds);
  const vh = viewHeight(bounds);
  const fit = Math.min(w / vw, h / vh);
  const contentW = vw * fit;
  const contentH = vh * fit;
  const ox = rect.left + (w - contentW) / 2;
  const oy = rect.top + (h - contentH) / 2;

  const svgX = bounds.minX + ((clientX - ox) / contentW) * vw;
  const svgY = -bounds.maxY + ((clientY - oy) / contentH) * vh;
  const p1x = svgX;
  const p1y = -svgY;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    x: (p1x - cx - cam.panX) / cam.zoom + cx,
    y: (p1y - cy - cam.panY) / cam.zoom + cy,
  };
}

export function cameraTransform(bounds: PlanView, cam: Camera): string {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  // Zoom about building centre, then pan in world XY (inside the Y-flip group).
  return `translate(${cam.panX} ${cam.panY}) translate(${cx} ${cy}) scale(${cam.zoom}) translate(${-cx} ${-cy})`;
}

/** Screen-pixel drag → camera pan (viewBox units, Y-up inside the flip group). */
export function clientDeltaToPan(
  svg: SVGSVGElement,
  bounds: PlanView,
  dxClient: number,
  dyClient: number,
): Point2 {
  const rect = svg.getBoundingClientRect();
  const w = Math.max(rect.width, 1);
  const h = Math.max(rect.height, 1);
  const vw = viewWidth(bounds);
  const vh = viewHeight(bounds);
  const fit = Math.min(w / vw, h / vh);
  if (!(fit > 0) || !Number.isFinite(fit)) return { x: 0, y: 0 };
  // meet letterboxing cancels in deltas; SVG Y-down → world panY flips.
  return { x: dxClient / fit, y: -(dyClient / fit) };
}

/** Nearest of `portals` to `point` within `maxDist` (world units), for click hit-testing. */
export function nearestPortalWithin<T extends { point: Point2 }>(
  portals: readonly T[],
  point: Point2,
  maxDist: number,
): T | null {
  let best: T | null = null;
  let bestDist = maxDist;
  for (const p of portals) {
    const d = Math.hypot(p.point.x - point.x, p.point.y - point.y);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}
