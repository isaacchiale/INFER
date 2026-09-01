import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Maximize2 } from "lucide-react";
import { useInfer } from "@/state/infer-store";
import { continuousPolylineForStorey } from "@/lib/geometric-path";
import { normalizeElevationsToMetres } from "@/lib/storey-elevations";
import {
  ifcElevationFromThree,
  planTranslationFromCentres,
  pointInBuildingBounds,
  storeyIdForElevation,
  threeAabbCentre,
  threeToIfcPlanResolved,
} from "@/lib/viewer-camera-pose";
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

type PlanLayer = "spaces" | "walls" | "doors" | "stairs" | "route" | "start" | "end";

const DEFAULT_PLAN_LAYERS: Record<PlanLayer, boolean> = {
  spaces: true,
  walls: true,
  doors: true,
  stairs: true,
  route: true,
  start: true,
  end: true,
};

type PlanView = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type Point2 = { x: number; y: number };

type Camera = {
  /** World-space pan (applied after Y-flip, in the same XY as footprints). */
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

const IDENTITY_CAMERA: Camera = { panX: 0, panY: 0, zoom: 1 };

/**
 * Map a client pixel through the fixed building viewBox + camera transform
 * into footprint world XY (Y-up).
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
    connectivityGraph,
    connectivityRoute,
    excludedNodeIds,
    viewerCameraPose,
    viewerModelBounds,
    viewerCoordInverse,
  } = useInfer();

  const svgRef = useRef<SVGSVGElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const cameraGroupRef = useRef<SVGGElement | null>(null);
  const cameraRef = useRef<Camera>({ ...IDENTITY_CAMERA });
  const boundsRef = useRef<PlanView | null>(null);
  /** Residual Three↔footprint translation (locked per model; not an axis flip). */
  const planDeltaRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const draggingRef = useRef(false);
  const [layers, setLayers] = useState<Record<PlanLayer, boolean>>(DEFAULT_PLAN_LAYERS);

  const toggleLayer = useCallback((key: PlanLayer) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const footprintsId = footprintsDocument?.model_id ?? null;

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
    for (const w of footprintsDocument.walls ?? []) {
      if (w.incomplete) continue;
      for (const p of w.polygon) pts.push(p);
    }
    return pts;
  }, [footprintsDocument]);

  const buildingBounds = useMemo(
    () => boundsFromPoints(buildingPoints),
    [buildingPoints],
  );
  /** Unpadded footprint AABB — used to lock Three→plan axis frame per model. */
  const footprintBoundsTight = useMemo(
    () => boundsFromPoints(buildingPoints, 0),
    [buildingPoints],
  );
  boundsRef.current = buildingBounds;

  /** Storey elevations in metres (footprints may be mm). */
  const storeysMetres = useMemo(() => {
    const raw = footprintsDocument?.storeys ?? [];
    const withElev = raw.filter(
      (s): s is { global_id: string; name: string; elevation: number } =>
        s.elevation != null && Number.isFinite(s.elevation),
    );
    if (!withElev.length) return [] as Array<{ global_id: string; elevation: number }>;
    const { metres } = normalizeElevationsToMetres(withElev.map((s) => s.elevation));
    return withElev.map((s, i) => ({
      global_id: s.global_id,
      elevation: metres[i]!,
    }));
  }, [footprintsDocument]);

  /**
   * 3D camera as plan blue dot: only when inside the building footprint AABB
   * and on the storey currently shown (or any storey when viewing "all").
   *
   * Prefer Fragments coordination-matrix inverse (exact origin undo). Fall back
   * to centre translation when that matrix is missing/identity.
   */
  const cameraDotInfo = useMemo(() => {
    if (!viewerCameraPose) {
      return { dot: null as { x: number; y: number } | null, reason: "no 3D pose yet" };
    }
    if (!buildingBounds) {
      return { dot: null, reason: "no footprints" };
    }
    const three = viewerCameraPose.three ?? {
      x: viewerCameraPose.x,
      y: viewerCameraPose.elevation,
      z: -viewerCameraPose.y,
    };

    const hasCoord = Boolean(viewerCoordInverse && viewerCoordInverse.length >= 16);

    if (
      !hasCoord &&
      planDeltaRef.current == null &&
      viewerModelBounds &&
      footprintBoundsTight
    ) {
      const delta = planTranslationFromCentres(
        threeAabbCentre(viewerModelBounds),
        footprintBoundsTight,
      );
      planDeltaRef.current =
        Math.abs(delta.x) < 0.05 && Math.abs(delta.y) < 0.05 ? { x: 0, y: 0 } : delta;
    }

    if (!hasCoord && planDeltaRef.current == null && footprintBoundsTight) {
      return { dot: null, reason: "calibrating plan ↔ 3D origin…" };
    }

    const mapped = threeToIfcPlanResolved(
      three,
      hasCoord ? viewerCoordInverse : null,
      hasCoord ? null : planDeltaRef.current,
    );
    // When coordination matrix restores absolute IFC Z, prefer that elevation;
    // otherwise lift Three Y onto storey elevations.
    const elev = hasCoord
      ? mapped.elevation
      : ifcElevationFromThree(
          mapped.elevation,
          viewerModelBounds,
          storeysMetres.map((s) => s.elevation),
        );
    const plan = { x: mapped.x, y: mapped.y, elevation: elev };
    if (!pointInBuildingBounds(plan.x, plan.y, buildingBounds, 2)) {
      return {
        dot: null,
        reason: "outside building — fly inside to see the camera dot",
      };
    }
    if (activeStoreyId !== "all" && storeysMetres.length) {
      const poseStorey = storeyIdForElevation(storeysMetres, plan.elevation);
      if (!poseStorey || poseStorey !== activeStoreyId) {
        const name =
          storeys.find((s) => s.global_id === poseStorey)?.name ?? poseStorey ?? "?";
        return {
          dot: null,
          reason: `camera on ${name} — switch floorplan level to match`,
        };
      }
    }
    return { dot: { x: plan.x, y: plan.y }, reason: "tracking" };
  }, [
    viewerCameraPose,
    viewerModelBounds,
    viewerCoordInverse,
    buildingBounds,
    footprintBoundsTight,
    storeysMetres,
    activeStoreyId,
    storeys,
  ]);
  const cameraDot = cameraDotInfo.dot;
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
    planDeltaRef.current = null;
    resetCamera();
  }, [footprintsId, resetCamera]);

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

  /** Walls: match storey when known; unassigned walls show on every storey. */
  const walls = useMemo(() => {
    const list = footprintsDocument?.walls ?? [];
    return list.filter((w) => {
      if (w.incomplete || w.polygon.length < 3) return false;
      if (activeStoreyId === "all") return true;
      if (w.storey_global_id == null) return true;
      return w.storey_global_id === activeStoreyId;
    });
  }, [footprintsDocument, activeStoreyId]);

  const overlay = useMemo(() => {
    if (!footprintsDocument || !connectivityRoute?.found) return null;
    return continuousPolylineForStorey(
      connectivityRoute.node_ids,
      footprintsDocument,
      activeStoreyId,
      connectivityGraph,
    );
  }, [
    footprintsDocument,
    connectivityRoute,
    activeStoreyId,
    connectivityGraph,
  ]);

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
  // vector-effect:non-scaling-stroke — under scale(1,-1) it desyncs strokes
  // from fills (brown door ring offset, grey outline ≠ polygon).
  const markerBase = buildingBounds
    ? Math.max(viewWidth(buildingBounds), viewHeight(buildingBounds))
    : 10;
  const roomStroke = markerBase * 0.0012;
  const endpointStroke = markerBase * 0.0024;
  const routeStroke = markerBase * 0.004;
  const routeHalo = markerBase * 0.008;
  const doorR = markerBase * 0.008;
  const doorStroke = markerBase * 0.0015;
  const cameraR = markerBase * 0.018;

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
  }, [applyCameraDom, buildingBounds, activeStoreyId, footprintsId]);

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

          <button
            type="button"
            onClick={resetCamera}
            disabled={!buildingBounds}
            className={cn(
              GLASS,
              "pointer-events-auto inline-flex h-8 items-center gap-1 px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40",
            )}
            title="Fit all floors (shared frame)"
          >
            <Maximize2 className="size-3" />
            Fit
          </button>
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
                  {layers.walls
                    ? walls.map((w) => (
                        <path
                          key={`wall:${w.global_id}`}
                          d={polygonPathD(w.polygon)}
                          fill="rgba(236,72,153,0.45)"
                          stroke="#db2777"
                          strokeWidth={roomStroke}
                        >
                          <title>{w.name ? `Wall: ${w.name}` : "Wall"}</title>
                        </path>
                      ))
                    : null}
                  {layers.spaces
                    ? spaces.map((s) => {
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
                      })
                    : null}
                  {layers.stairs
                    ? stairs.map((s) => {
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
                      })
                    : null}
                  {layers.doors
                    ? doors.map((d) =>
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
                      )
                    : null}

                  {layers.route && pathD ? (
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
                  {layers.route && pathD ? (
                    <path
                      d={pathD}
                      fill="none"
                      stroke="#1d4ed8"
                      strokeWidth={routeStroke}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ) : null}

                  {layers.start && routeEndpointSpaces.start ? (
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
                  {layers.end && routeEndpointSpaces.end ? (
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

                  {cameraDot ? (
                    <g>
                      <circle
                        cx={cameraDot.x}
                        cy={cameraDot.y}
                        r={cameraR * 1.65}
                        fill="rgba(37,99,235,0.25)"
                        stroke="none"
                      />
                      <circle
                        cx={cameraDot.x}
                        cy={cameraDot.y}
                        r={cameraR}
                        fill="#2563eb"
                        stroke="#eff6ff"
                        strokeWidth={doorStroke * 1.5}
                      >
                        <title>3D camera</title>
                      </circle>
                    </g>
                  ) : null}
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

            <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-20 flex flex-wrap items-center gap-1.5 rounded-md border border-border/80 bg-background/90 px-2 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
              {(
                [
                  {
                    key: "start" as const,
                    label: "Start",
                    swatch: (
                      <span
                        className="inline-block size-2.5 border-2 border-[#16a34a]"
                        style={{ background: "rgba(22,163,74,0.25)" }}
                      />
                    ),
                  },
                  {
                    key: "route" as const,
                    label: "Route",
                    swatch: <span className="inline-block h-0.5 w-4 bg-[#1d4ed8]" />,
                  },
                  {
                    key: "end" as const,
                    label: "End",
                    swatch: (
                      <span
                        className="inline-block size-2.5 border-2 border-[#dc2626]"
                        style={{ background: "rgba(220,38,38,0.25)" }}
                      />
                    ),
                  },
                  {
                    key: "spaces" as const,
                    label: "Space",
                    swatch: (
                      <span
                        className="inline-block size-2.5 border border-[#64748b]"
                        style={{ background: "rgba(148,163,184,0.35)" }}
                      />
                    ),
                  },
                  {
                    key: "walls" as const,
                    label: "Wall",
                    swatch: (
                      <span
                        className="inline-block size-2.5 border border-[#db2777]"
                        style={{ background: "rgba(236,72,153,0.45)" }}
                      />
                    ),
                  },
                  {
                    key: "doors" as const,
                    label: "Door",
                    swatch: <span className="inline-block size-2 rounded-full bg-[#f59e0b]" />,
                  },
                  {
                    key: "stairs" as const,
                    label: "Stair",
                    swatch: (
                      <span
                        className="inline-block h-0.5 w-4 border-t-2 border-dashed"
                        style={{ borderColor: "#7c3aed" }}
                      />
                    ),
                  },
                ] as const
              ).map((item) => {
                const on = layers[item.key];
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={cn(
                      "pointer-events-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
                      on
                        ? "text-foreground hover:bg-muted"
                        : "text-muted-foreground/50 line-through hover:bg-muted/60",
                    )}
                    aria-pressed={on}
                    title={on ? `Hide ${item.label}` : `Show ${item.label}`}
                    onClick={() => toggleLayer(item.key)}
                  >
                    {item.swatch}
                    {item.label}
                  </button>
                );
              })}
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
                  cameraDot ? "text-foreground" : "text-muted-foreground/50",
                )}
                title={cameraDotInfo.reason}
              >
                <span className="inline-block size-2 rounded-full bg-[#2563eb]" />
                Camera
                {!cameraDot ? (
                  <span className="max-w-[14rem] truncate text-[10px] font-normal opacity-80">
                    ({cameraDotInfo.reason})
                  </span>
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate px-1">
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
