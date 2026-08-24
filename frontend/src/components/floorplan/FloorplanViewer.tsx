import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Maximize2 } from "lucide-react";
import { useInfer } from "@/state/infer-store";
import { continuousPolylineForStorey } from "@/lib/geometric-path";
import { cn } from "@/lib/utils";
import type { FootprintsDocument, SpaceFootprint } from "@/types/footprints";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Same canvas colours as Graph Viewer (`graphPalette`). */
const PLAN_CANVAS = "bg-[#F8FAFC] dark:bg-[#0F1117]";

const GLASS =
  "rounded-[6px] border border-border bg-background/90 shadow-sm backdrop-blur-[2px]";

type PlanView = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type Point2 = { x: number; y: number };

type Camera = {
  /** Pan in display/viewBox space (after optional plan-align rotate). */
  panX: number;
  panY: number;
  /** 1 = fit to building bounds. */
  zoom: number;
};

function viewWidth(v: PlanView) {
  return Math.max(v.maxX - v.minX, 1e-6);
}
function viewHeight(v: PlanView) {
  return Math.max(v.maxY - v.minY, 1e-6);
}

function toViewBox(v: PlanView) {
  // SVG Y grows down; world Y grows up — flip via negative Y origin on the root viewBox.
  return `${v.minX} ${-v.maxY} ${viewWidth(v)} ${viewHeight(v)}`;
}

function boundsFromPoints(points: Point2[], padRatio = 0.08): PlanView | null {
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
  const pad = Math.max((maxX - minX) * padRatio, (maxY - minY) * padRatio, 0.5);
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

function centroidOfPoints(points: Point2[]): Point2 {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const n = Math.max(points.length, 1);
  return { x: sx / n, y: sy / n };
}

function rotatePoint(p: Point2, cx: number, cy: number, angleRad: number): Point2 {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const x = p.x - cx;
  const y = p.y - cy;
  return { x: cx + x * cos - y * sin, y: cy + x * sin + y * cos };
}

/** Monotone-chain convex hull (XY). */
function convexHull(points: Point2[]): Point2[] {
  const uniq = new Map<string, Point2>();
  for (const p of points) {
    uniq.set(`${p.x.toFixed(4)},${p.y.toFixed(4)}`, p);
  }
  const pts = [...uniq.values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;

  const cross = (o: Point2, a: Point2, b: Point2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Angle (radians) of the longest convex-hull edge, normalized to (-π/2, π/2]
 * so rotating by −angle makes that edge horizontal without flipping upside-down.
 * Display-only — does not alter footprint / routing coordinates.
 */
function longestEdgeAlignAngle(points: Point2[]): number {
  const hull = convexHull(points);
  if (hull.length < 2) return 0;
  let bestLen = 0;
  let bestAngle = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len > bestLen) {
      bestLen = len;
      bestAngle = Math.atan2(dy, dx);
    }
  }
  // Keep nearly-horizontal: fold into (-π/2, π/2].
  while (bestAngle > Math.PI / 2) bestAngle -= Math.PI;
  while (bestAngle <= -Math.PI / 2) bestAngle += Math.PI;
  return bestAngle;
}

const IDENTITY_CAMERA: Camera = { panX: 0, panY: 0, zoom: 1 };

/**
 * Map a client pixel through the fixed building viewBox + camera transform
 * into display XY (Y-up; plan-aligned when align is on).
 */
function clientToView(
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

function cameraTransform(bounds: PlanView, cam: Camera): string {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  // Zoom about building centre, then pan in world XY (inside the Y-flip group).
  return `translate(${cam.panX} ${cam.panY}) translate(${cx} ${cy}) scale(${cam.zoom}) translate(${-cx} ${-cy})`;
}

function polygonPathD(polygon: Point2[]): string {
  return polygon.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") + " Z";
}

/** Exterior + holes as one SVG path (evenodd voids). */
function spacePathD(exterior: Point2[], holes?: Point2[][]): string {
  let d = polygonPathD(exterior);
  for (const hole of holes ?? []) {
    if (hole.length >= 3) d += " " + polygonPathD(hole);
  }
  return d;
}

/** Resolve `space:<globalId>` from the route to a drawable footprint. */
function spaceForRouteNode(
  footprints: FootprintsDocument,
  nodeId: string,
): SpaceFootprint | null {
  const idx = nodeId.indexOf(":");
  if (idx <= 0 || nodeId.slice(0, idx) !== "space") return null;
  const gid = nodeId.slice(idx + 1);
  const space = footprints.spaces.find((s) => s.global_id === gid);
  if (!space || space.incomplete || space.polygon.length < 3) return null;
  return space;
}

/** Screen-pixel drag → camera pan (viewBox units, Y-up inside the flip group). */
function clientDeltaToPan(
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

export function FloorplanViewer({ className }: { className?: string }) {
  const {
    footprintsDocument,
    entitiesExtract,
    activeStoreyId,
    setActiveStoreyId,
    connectivityRoute,
    excludedNodeIds,
  } = useInfer();

  const svgRef = useRef<SVGSVGElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const cameraGroupRef = useRef<SVGGElement | null>(null);
  const cameraRef = useRef<Camera>({ ...IDENTITY_CAMERA });
  const boundsRef = useRef<PlanView | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const draggingRef = useRef(false);

  const footprintsId = footprintsDocument?.model_id ?? null;
  /** Display-only: rotate longest hull edge to horizontal (routing stays in world XY). */
  const [alignPlan, setAlignPlan] = useState(true);

  const storeys = useMemo(() => {
    const fromFp = footprintsDocument?.storeys ?? [];
    if (fromFp.length) {
      return [...fromFp].sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
    }
    return (entitiesExtract?.storeys ?? []).map((s) => ({
      global_id: s.global_id,
      name: s.name,
      elevation: s.elevation,
    }));
  }, [footprintsDocument, entitiesExtract]);

  useEffect(() => {
    if (!storeys.length) return;
    if (activeStoreyId !== "all" && storeys.some((s) => s.global_id === activeStoreyId)) {
      return;
    }
    const first = storeys[0];
    if (first) setActiveStoreyId(first.global_id);
  }, [storeys, activeStoreyId, setActiveStoreyId]);

  const buildingPoints = useMemo(() => {
    if (!footprintsDocument) return [] as Point2[];
    const pts: Point2[] = [];
    for (const s of footprintsDocument.spaces) {
      if (s.incomplete) continue;
      for (const p of s.polygon) pts.push(p);
    }
    for (const d of footprintsDocument.doors) {
      if (d.point && !d.incomplete) pts.push(d.point);
    }
    for (const st of footprintsDocument.stairs ?? []) {
      if (st.incomplete) continue;
      for (const p of st.polygon) pts.push(p);
    }
    return pts;
  }, [footprintsDocument]);

  const planAlign = useMemo(() => {
    if (!buildingPoints.length) {
      return { angleRad: 0, cx: 0, cy: 0, bounds: null as PlanView | null };
    }
    const c = centroidOfPoints(buildingPoints);
    const angleRad = alignPlan ? longestEdgeAlignAngle(buildingPoints) : 0;
    const displayPts =
      angleRad === 0
        ? buildingPoints
        : buildingPoints.map((p) => rotatePoint(p, c.x, c.y, -angleRad));
    return {
      angleRad,
      cx: c.x,
      cy: c.y,
      bounds: boundsFromPoints(displayPts),
    };
  }, [buildingPoints, alignPlan]);

  const buildingBounds = planAlign.bounds;
  boundsRef.current = buildingBounds;

  const applyCameraDom = useCallback(() => {
    const g = cameraGroupRef.current;
    const bounds = boundsRef.current;
    if (!g || !bounds) return;
    g.setAttribute("transform", cameraTransform(bounds, cameraRef.current));
  }, []);

  const resetCamera = useCallback(() => {
    cameraRef.current = { ...IDENTITY_CAMERA };
    applyCameraDom();
  }, [applyCameraDom]);

  // New model → reset camera; keep camera across storey switches.
  useEffect(() => {
    resetCamera();
  }, [footprintsId, resetCamera]);

  // Re-fit when toggling align (bounds/orientation change).
  useEffect(() => {
    resetCamera();
  }, [alignPlan, resetCamera]);

  const spaces = useMemo(() => {
    if (!footprintsDocument) return [];
    const keep = (s: { global_id: string; incomplete: boolean; polygon: unknown[] }) =>
      !s.incomplete &&
      s.polygon.length >= 3 &&
      !excludedNodeIds.has(`space:${s.global_id}`);
    if (activeStoreyId === "all") {
      return footprintsDocument.spaces.filter(keep);
    }
    return footprintsDocument.spaces.filter(
      (s) => s.storey_global_id === activeStoreyId && keep(s),
    );
  }, [footprintsDocument, activeStoreyId, excludedNodeIds]);

  const doors = useMemo(() => {
    if (!footprintsDocument) return [];
    if (activeStoreyId === "all") {
      return footprintsDocument.doors.filter((d) => d.point && !d.incomplete);
    }
    return footprintsDocument.doors.filter(
      (d) => d.storey_global_id === activeStoreyId && d.point && !d.incomplete,
    );
  }, [footprintsDocument, activeStoreyId]);

  /**
   * Stairs often sit on one containment storey but represent a vertical shaft.
   * Show on matching storey; if unassigned, show on every storey so they aren't lost.
   */
  const stairs = useMemo(() => {
    const list = footprintsDocument?.stairs ?? [];
    return list.filter((s) => {
      if (s.incomplete || s.polygon.length < 3) return false;
      if (excludedNodeIds.has(`stair:${s.global_id}`)) return false;
      if (activeStoreyId === "all") return true;
      if (s.storey_global_id == null) return true;
      return s.storey_global_id === activeStoreyId;
    });
  }, [footprintsDocument, activeStoreyId, excludedNodeIds]);

  const overlay = useMemo(() => {
    if (!footprintsDocument || !connectivityRoute?.found) return null;
    return continuousPolylineForStorey(
      connectivityRoute.node_ids,
      footprintsDocument,
      activeStoreyId,
    );
  }, [footprintsDocument, connectivityRoute, activeStoreyId]);

  /** Origin / destination IfcSpace polygons (not path centroids). */
  const routeEndpointSpaces = useMemo(() => {
    if (!footprintsDocument || !connectivityRoute?.found) {
      return { start: null, end: null };
    }
    const onStorey = (storey: string | null) =>
      activeStoreyId === "all" || storey == null || storey === activeStoreyId;
    const start = spaceForRouteNode(
      footprintsDocument,
      connectivityRoute.origin_node_id,
    );
    const end = spaceForRouteNode(
      footprintsDocument,
      connectivityRoute.destination_node_id,
    );
    return {
      start: start && onStorey(start.storey_global_id) ? start : null,
      end: end && onStorey(end.storey_global_id) ? end : null,
    };
  }, [footprintsDocument, connectivityRoute, activeStoreyId]);

  const pathPoints = overlay?.points ?? [];
  const viewBox = buildingBounds ? toViewBox(buildingBounds) : "0 0 10 10";

  // Stroke widths in world metres (fraction of building size). Avoid
  // vector-effect:non-scaling-stroke — under scale(1,-1) + align rotate it
  // desyncs strokes from fills (brown door ring offset, grey outline ≠ polygon).
  const markerBase = buildingBounds
    ? Math.max(viewWidth(buildingBounds), viewHeight(buildingBounds))
    : 10;
  const roomStroke = markerBase * 0.0012;
  const endpointStroke = markerBase * 0.0024;
  const routeStroke = markerBase * 0.004;
  const routeHalo = markerBase * 0.008;
  const doorR = markerBase * 0.008;
  const doorStroke = markerBase * 0.0015;

  const incompleteCount =
    footprintsDocument?.spaces.filter((s) => s.incomplete).length ?? 0;

  const pathD =
    pathPoints.length >= 2
      ? pathPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")
      : "";

  // Restore camera transform after React commits geometry (do not put transform in JSX —
  // React re-renders were wiping pan/zoom). Skip while dragging so layout can't fight the gesture.
  useLayoutEffect(() => {
    if (draggingRef.current) return;
    applyCameraDom();
  }, [applyCameraDom, buildingBounds, activeStoreyId, footprintsId, alignPlan]);

  // Stable overlay owns pointer/wheel so SVG re-renders never break capture mid-pan.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !footprintsDocument) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const bounds = boundsRef.current;
      const svg = svgRef.current;
      if (!bounds || !svg) return;

      const cam = cameraRef.current;
      const viewBefore = clientToView(e.clientX, e.clientY, svg, bounds, cam);
      const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      const nextZoom = Math.min(Math.max(cam.zoom * factor, 0.25), 40);
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      const next = {
        zoom: nextZoom,
        panX: cam.panX + (viewBefore.x - cx) * (cam.zoom - nextZoom),
        panY: cam.panY + (viewBefore.y - cy) * (cam.zoom - nextZoom),
      };
      if (!Number.isFinite(next.panX) || !Number.isFinite(next.panY) || !Number.isFinite(next.zoom)) {
        return;
      }
      cameraRef.current = next;
      applyCameraDom();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      draggingRef.current = true;
      surface.setPointerCapture(e.pointerId);
      dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const bounds = boundsRef.current;
      const svg = svgRef.current;
      if (!bounds || !svg) return;

      const d = clientDeltaToPan(
        svg,
        bounds,
        e.clientX - drag.lastX,
        e.clientY - drag.lastY,
      );
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) return;

      const cam = cameraRef.current;
      cameraRef.current = {
        ...cam,
        panX: cam.panX + d.x,
        panY: cam.panY + d.y,
      };
      applyCameraDom();
    };

    const endDrag = (e: PointerEvent) => {
      if (dragRef.current?.pointerId !== e.pointerId) return;
      dragRef.current = null;
      draggingRef.current = false;
      try {
        if (surface.hasPointerCapture(e.pointerId)) {
          surface.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* ignore */
      }
      applyCameraDom();
    };

    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", endDrag);
    surface.addEventListener("pointercancel", endDrag);
    return () => {
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", endDrag);
      surface.removeEventListener("pointercancel", endDrag);
      dragRef.current = null;
      draggingRef.current = false;
    };
  }, [footprintsId, footprintsDocument, applyCameraDom]);

  const activeStoreyLabel = useMemo(() => {
    if (!storeys.length) return "No storeys";
    const match = storeys.find((s) => s.global_id === activeStoreyId);
    if (!match) return "Select storey";
    return (
      match.name?.trim() ||
      (match.elevation != null ? `E${match.elevation}` : match.global_id.slice(0, 8))
    );
  }, [storeys, activeStoreyId]);

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col", PLAN_CANVAS, className)}>
      <div className={cn("relative min-h-0 flex-1", PLAN_CANVAS)}>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-3">
          <div className="pointer-events-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={!storeys.length}
                  className={cn(
                    GLASS,
                    "flex h-8 max-w-[220px] items-center gap-1.5 px-2.5 text-[12px] text-foreground transition-colors hover:bg-muted disabled:opacity-40",
                  )}
                  title="Storey"
                >
                  <span className="min-w-0 truncate">{activeStoreyLabel}</span>
                  <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 min-w-[10rem] overflow-y-auto">
                {storeys.map((s) => {
                  const label =
                    s.name?.trim() ||
                    (s.elevation != null ? `E${s.elevation}` : s.global_id.slice(0, 8));
                  const active = activeStoreyId === s.global_id;
                  return (
                    <DropdownMenuItem
                      key={s.global_id}
                      className="text-[12px]"
                      onSelect={() => setActiveStoreyId(s.global_id)}
                    >
                      {active ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                      {label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="pointer-events-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAlignPlan((v) => !v)}
              disabled={!buildingBounds}
              className={cn(
                GLASS,
                "inline-flex h-8 items-center gap-1 px-2.5 text-[11px] transition-colors disabled:opacity-40",
                alignPlan
                  ? "text-foreground hover:bg-muted"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              title="Display-only: rotate longest building edge to horizontal (routing stays in world XY)"
            >
              {alignPlan ? <Check className="size-3" /> : null}
              Align
            </button>
            <button
              type="button"
              onClick={resetCamera}
              disabled={!buildingBounds}
              className={cn(
                GLASS,
                "inline-flex h-8 items-center gap-1 px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40",
              )}
              title="Fit all floors (shared frame)"
            >
              <Maximize2 className="size-3" />
              Fit
            </button>
          </div>
        </div>

        {!footprintsDocument ? (
          <div className="grid h-full place-items-center px-4 text-center text-xs text-muted-foreground">
            Footprints not loaded. Ingest a model to build space polygons for the plan.
          </div>
        ) : (
          <>
            <svg
              ref={svgRef}
              className={cn("pointer-events-none h-full w-full", PLAN_CANVAS)}
              viewBox={viewBox}
              preserveAspectRatio="xMidYMid meet"
            >
              <g transform="scale(1,-1)">
                <g ref={cameraGroupRef}>
                  <g
                    transform={
                      planAlign.angleRad !== 0
                        ? `rotate(${(-planAlign.angleRad * 180) / Math.PI} ${planAlign.cx} ${planAlign.cy})`
                        : undefined
                    }
                  >
                  {spaces.map((s) => {
                    return (
                      <path
                        key={s.global_id}
                        d={spacePathD(s.polygon, s.holes)}
                        fill="rgba(148,163,184,0.35)"
                        fillRule="evenodd"
                        stroke="#64748b"
                        strokeWidth={roomStroke}
                      >
                        <title>{s.name || s.global_id}</title>
                      </path>
                    );
                  })}
                  {stairs.map((s) => {
                    return (
                      <path
                        key={`stair:${s.global_id}`}
                        d={polygonPathD(s.polygon)}
                        fill="none"
                        stroke="#7c3aed"
                        strokeWidth={roomStroke * 1.4}
                        strokeDasharray={`${markerBase * 0.006} ${markerBase * 0.004}`}
                      >
                        <title>{s.name ? `Stair: ${s.name}` : "Stair"}</title>
                      </path>
                    );
                  })}
                  {doors.map((d) =>
                    d.point ? (
                      <circle
                        key={d.global_id}
                        cx={d.point.x}
                        cy={d.point.y}
                        r={doorR}
                        fill="#f59e0b"
                        stroke="#92400e"
                        strokeWidth={doorStroke}
                      >
                        <title>{d.name || d.global_id}</title>
                      </circle>
                    ) : null,
                  )}

                  {pathD ? (
                    <path
                      d={pathD}
                      fill="none"
                      stroke="#93c5fd"
                      strokeWidth={routeHalo}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.85}
                    />
                  ) : null}
                  {pathD ? (
                    <path
                      d={pathD}
                      fill="none"
                      stroke="#1d4ed8"
                      strokeWidth={routeStroke}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ) : null}

                  {routeEndpointSpaces.start ? (
                    <path
                      d={spacePathD(
                        routeEndpointSpaces.start.polygon,
                        routeEndpointSpaces.start.holes,
                      )}
                      fill="rgba(22,163,74,0.18)"
                      fillRule="evenodd"
                      stroke="#16a34a"
                      strokeWidth={endpointStroke}
                    >
                      <title>
                        Start:{" "}
                        {routeEndpointSpaces.start.name ||
                          routeEndpointSpaces.start.global_id}
                      </title>
                    </path>
                  ) : null}
                  {routeEndpointSpaces.end ? (
                    <path
                      d={spacePathD(
                        routeEndpointSpaces.end.polygon,
                        routeEndpointSpaces.end.holes,
                      )}
                      fill="rgba(220,38,38,0.18)"
                      fillRule="evenodd"
                      stroke="#dc2626"
                      strokeWidth={endpointStroke}
                    >
                      <title>
                        End:{" "}
                        {routeEndpointSpaces.end.name ||
                          routeEndpointSpaces.end.global_id}
                      </title>
                    </path>
                  ) : null}
                  </g>
                </g>
              </g>
            </svg>

            {/* Stable hit target — must not remount when geometry/route updates. */}
            <div
              ref={surfaceRef}
              className="absolute inset-0 z-10 cursor-grab touch-none select-none active:cursor-grabbing"
              aria-label="Floorplan pan and zoom surface"
            />

            {spaces.length === 0 && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center px-4 text-center text-xs text-muted-foreground">
                No complete footprints on this storey
                {incompleteCount > 0 ? ` (${incompleteCount} incomplete in model)` : ""}.
                IFC spaces need placement or mesh geometry.
              </div>
            )}

            <div className="pointer-events-none absolute bottom-2 left-2 right-2 flex flex-wrap items-center gap-3 rounded-md border border-border/80 bg-background/90 px-2 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-block size-2.5 border-2 border-[#16a34a]"
                  style={{ background: "rgba(22,163,74,0.25)" }}
                />{" "}
                Start
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-0.5 w-4 bg-[#1d4ed8]" /> Route
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-block size-2.5 border-2 border-[#dc2626]"
                  style={{ background: "rgba(220,38,38,0.25)" }}
                />{" "}
                End
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block size-2 rounded-full bg-[#f59e0b]" /> Door
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-block h-0.5 w-4 border-t-2 border-dashed"
                  style={{ borderColor: "#7c3aed" }}
                />{" "}
                Stair
              </span>
              <span className="min-w-0 flex-1 truncate">
                {connectivityRoute?.found
                  ? pathPoints.length >= 2
                    ? overlay?.note
                    : overlay?.note || "Route has no drawable points on this storey"
                  : null}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
