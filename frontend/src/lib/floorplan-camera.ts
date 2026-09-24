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
  /**
   * Pan in the Y-up flip group, axis-aligned to the SVG (applied after
   * rotate+zoom about the building centre). Dragging right always increases
   * panX regardless of {@link rotation}.
   */
  panX: number;
  panY: number;
  /** 1 = fit to building bounds. */
  zoom: number;
  /**
   * Plan rotation in radians, counterclockwise in world Y-up (same sense as
   * SVG `rotate` inside the Y-flip group). 0 = north-up as authored.
   */
  rotation: number;
};

export const IDENTITY_CAMERA: Camera = { panX: 0, panY: 0, zoom: 1, rotation: 0 };

/** Snap `radians` onto (−π, π] so the Fit/reset path and UI stay tidy. */
export function normalizeRotation(radians: number): number {
  if (!Number.isFinite(radians)) return 0;
  let r = radians % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

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
 * Smooth an ordered polyline into a centripetal Catmull-Rom curve, emitted as
 * cubic-Bezier SVG segments — the same curve the 3D viewer's route tube uses
 * (THREE.CatmullRomCurve3 "centripetal"), so both panes draw the route with
 * the same shape. Centripetal (not uniform) parametrization matters: grid
 * routes put short hops next to long runs around doorways, and a uniform
 * curve overshoots there into visible kinks. Purely a display curve: it
 * passes through every original point.
 */
export function smoothPolylinePathD(points: Point2[]): string {
  const n = points.length;
  if (n < 2) return "";
  if (n === 2) return `M${points[0]!.x} ${points[0]!.y} L${points[1]!.x} ${points[1]!.y}`;
  const at = (i: number) => points[Math.max(0, Math.min(n - 1, i))]!;
  const knot = (a: Point2, b: Point2) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y));
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const d1 = knot(p0, p1);
    const d2 = knot(p1, p2);
    const d3 = knot(p2, p3);
    let c1x: number;
    let c1y: number;
    let c2x: number;
    let c2y: number;
    // Conversion from Yuksel et al., "Parameterization and Applications of Catmull-Rom Curves".
    if (d1 < 1e-9 || d2 < 1e-9) {
      c1x = p1.x + (p2.x - p1.x) / 3;
      c1y = p1.y + (p2.y - p1.y) / 3;
    } else {
      const a = 2 * d1 * d1 + 3 * d1 * d2 + d2 * d2;
      const m = 3 * d1 * (d1 + d2);
      c1x = (d1 * d1 * p2.x - d2 * d2 * p0.x + a * p1.x) / m;
      c1y = (d1 * d1 * p2.y - d2 * d2 * p0.y + a * p1.y) / m;
    }
    if (d3 < 1e-9 || d2 < 1e-9) {
      c2x = p2.x - (p2.x - p1.x) / 3;
      c2y = p2.y - (p2.y - p1.y) / 3;
    } else {
      const b = 2 * d3 * d3 + 3 * d3 * d2 + d2 * d2;
      const m = 3 * d3 * (d3 + d2);
      c2x = (d3 * d3 * p1.x - d2 * d2 * p3.x + b * p2.x) / m;
      c2y = (d3 * d3 * p1.y - d2 * d2 * p3.y + b * p2.y) / m;
    }
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
  // Undo the root Y-flip group, then undo pan → rotate → zoom about centre.
  const p1x = svgX;
  const p1y = -svgY;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const qx = p1x - cx - cam.panX;
  const qy = p1y - cy - cam.panY;
  const cos = Math.cos(cam.rotation);
  const sin = Math.sin(cam.rotation);
  // R(−θ) · q, then undo scale.
  const rx = qx * cos + qy * sin;
  const ry = -qx * sin + qy * cos;
  const z = Math.max(cam.zoom, 1e-6);
  return { x: rx / z + cx, y: ry / z + cy };
}

export function cameraTransform(bounds: PlanView, cam: Camera): string {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const deg = (cam.rotation * 180) / Math.PI;
  // Zoom + rotate about building centre, then pan (inside the Y-flip group).
  return `translate(${cam.panX} ${cam.panY}) translate(${cx} ${cy}) rotate(${deg}) scale(${cam.zoom}) translate(${-cx} ${-cy})`;
}

/**
 * Pan delta that keeps `worldUnderCursor` fixed when zoom changes (with
 * rotation). `dz = oldZoom - newZoom`.
 */
export function panDeltaForZoomAt(
  bounds: PlanView,
  cam: Camera,
  worldUnderCursor: Point2,
  newZoom: number,
): Point2 {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const dx = worldUnderCursor.x - cx;
  const dy = worldUnderCursor.y - cy;
  const dz = cam.zoom - newZoom;
  const cos = Math.cos(cam.rotation);
  const sin = Math.sin(cam.rotation);
  // R(θ) · (world − centre) · dz
  return { x: (cos * dx - sin * dy) * dz, y: (sin * dx + cos * dy) * dz };
}

/**
 * Pan delta that keeps `worldPivot` fixed when rotation changes by
 * `deltaRotation` (new − old), at the current zoom.
 */
export function panDeltaForRotationAt(
  bounds: PlanView,
  cam: Camera,
  worldPivot: Point2,
  deltaRotation: number,
): Point2 {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const dx = (worldPivot.x - cx) * cam.zoom;
  const dy = (worldPivot.y - cy) * cam.zoom;
  const cos0 = Math.cos(cam.rotation);
  const sin0 = Math.sin(cam.rotation);
  const next = cam.rotation + deltaRotation;
  const cos1 = Math.cos(next);
  const sin1 = Math.sin(next);
  // pan' = pan + R(θ)·z·v − R(θ')·z·v
  return {
    x: cos0 * dx - sin0 * dy - (cos1 * dx - sin1 * dy),
    y: sin0 * dx + cos0 * dy - (sin1 * dx + cos1 * dy),
  };
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
