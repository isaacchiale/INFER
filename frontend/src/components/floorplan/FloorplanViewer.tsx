import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Check, ChevronDown, Maximize2 } from "lucide-react";
import { useInfer } from "@/state/infer-store";
import { continuousPolylineForStorey } from "@/lib/geometric-path";
import { cn } from "@/lib/utils";
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
  const pad = Math.max((maxX - minX) * padRatio, (maxY - minY) * padRatio, 0.5);
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
function clientToWorld(
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
  // Undo Y-flip: camera-space point before pan/zoom inverse.
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

/** Screen-pixel delta → SVG user units (viewBox space, Y down) via CTM. */
function screenDeltaToSvg(
  svg: SVGSVGElement,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Point2 {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const inv = ctm.inverse();
  const a = new DOMPoint(x0, y0).matrixTransform(inv);
  const b = new DOMPoint(x1, y1).matrixTransform(inv);
  return { x: b.x - a.x, y: b.y - a.y };
}

export function FloorplanViewer({ className }: { className?: string }) {
  const {
    footprintsDocument,
    entitiesExtract,
    activeStoreyId,
    setActiveStoreyId,
    connectivityRoute,
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

  const buildingBounds = useMemo(
    () => boundsFromPoints(buildingPoints),
    [buildingPoints],
  );
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

  const spaces = useMemo(() => {
    if (!footprintsDocument) return [];
    if (activeStoreyId === "all") {
      return footprintsDocument.spaces.filter((s) => !s.incomplete && s.polygon.length >= 3);
    }
    return footprintsDocument.spaces.filter(
      (s) =>
        s.storey_global_id === activeStoreyId && !s.incomplete && s.polygon.length >= 3,
    );
  }, [footprintsDocument, activeStoreyId]);

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
      if (activeStoreyId === "all") return true;
      if (s.storey_global_id == null) return true;
      return s.storey_global_id === activeStoreyId;
    });
  }, [footprintsDocument, activeStoreyId]);

  const overlay = useMemo(() => {
    if (!footprintsDocument || !connectivityRoute?.found) return null;
    return continuousPolylineForStorey(
      connectivityRoute.node_ids,
      footprintsDocument,
      activeStoreyId,
    );
  }, [footprintsDocument, connectivityRoute, activeStoreyId]);

  const pathPoints = overlay?.points ?? [];
  const viewBox = buildingBounds ? toViewBox(buildingBounds) : "0 0 10 10";

  const markerBase = buildingBounds
    ? Math.max(viewWidth(buildingBounds), viewHeight(buildingBounds))
    : 10;
  const routeStroke = 5;
  const roomStroke = 1.25;
  const doorR = markerBase * 0.008;
  const endR = markerBase * 0.012;

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
  }, [applyCameraDom, buildingBounds, spaces, doors, stairs, pathD, activeStoreyId]);

  // Stable overlay owns pointer/wheel so SVG re-renders never break capture mid-pan.
  useEffect(() => {
    const surface = surfaceRef.current;
    const svg = svgRef.current;
    if (!surface || !svg || !footprintsDocument) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const bounds = boundsRef.current;
      if (!bounds) return;

      const cam = cameraRef.current;
      const worldBefore = clientToWorld(e.clientX, e.clientY, svg, bounds, cam);
      const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      const nextZoom = Math.min(Math.max(cam.zoom * factor, 0.25), 40);
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      cameraRef.current = {
        zoom: nextZoom,
        panX: cam.panX + (worldBefore.x - cx) * (cam.zoom - nextZoom),
        panY: cam.panY + (worldBefore.y - cy) * (cam.zoom - nextZoom),
      };
      applyCameraDom();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      draggingRef.current = true;
      surface.setPointerCapture(e.pointerId);
      dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;

      // CTM delta accounts for viewBox + letterboxing; Y-flip ⇒ panY uses −ΔsvgY.
      const d = screenDeltaToSvg(svg, drag.lastX, drag.lastY, e.clientX, e.clientY);
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      const cam = cameraRef.current;
      cameraRef.current = {
        ...cam,
        panX: cam.panX + d.x,
        panY: cam.panY - d.y,
      };
      applyCameraDom();
    };

    const endDrag = (e: PointerEvent) => {
      if (dragRef.current?.pointerId !== e.pointerId) return;
      dragRef.current = null;
      draggingRef.current = false;
      try {
        surface.releasePointerCapture(e.pointerId);
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
    surface.addEventListener("lostpointercapture", endDrag);
    return () => {
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", endDrag);
      surface.removeEventListener("pointercancel", endDrag);
      surface.removeEventListener("lostpointercapture", endDrag);
    };
  }, [footprintsDocument, applyCameraDom]);

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
                  {spaces.map((s) => {
                    const d =
                      s.polygon.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") +
                      " Z";
                    return (
                      <path
                        key={s.global_id}
                        d={d}
                        fill="rgba(148,163,184,0.35)"
                        stroke="#64748b"
                        strokeWidth={roomStroke}
                        vectorEffect="non-scaling-stroke"
                      >
                        <title>{s.name || s.global_id}</title>
                      </path>
                    );
                  })}
                  {stairs.map((s) => {
                    const d =
                      s.polygon.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") +
                      " Z";
                    return (
                      <path
                        key={`stair:${s.global_id}`}
                        d={d}
                        fill="none"
                        stroke="#7c3aed"
                        strokeWidth={roomStroke + 0.5}
                        strokeDasharray="6 4"
                        vectorEffect="non-scaling-stroke"
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
                        strokeWidth={roomStroke}
                        vectorEffect="non-scaling-stroke"
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
                      strokeWidth={routeStroke + 4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
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
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}

                  {pathPoints[0] ? (
                    <circle
                      cx={pathPoints[0].x}
                      cy={pathPoints[0].y}
                      r={endR}
                      fill="#16a34a"
                      stroke="#fff"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>Start</title>
                    </circle>
                  ) : null}
                  {pathPoints.length > 1 ? (
                    <circle
                      cx={pathPoints[pathPoints.length - 1]!.x}
                      cy={pathPoints[pathPoints.length - 1]!.y}
                      r={endR}
                      fill="#dc2626"
                      stroke="#fff"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>End (this floor)</title>
                    </circle>
                  ) : null}
                </g>
              </g>
            </svg>

            {/* Stable hit target — must not remount when geometry/route updates. */}
            <div
              ref={surfaceRef}
              className="absolute inset-0 z-10 cursor-grab touch-none active:cursor-grabbing"
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
                <span className="inline-block size-2 rounded-full bg-[#16a34a]" /> Start
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-0.5 w-4 bg-[#1d4ed8]" /> Route
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block size-2 rounded-full bg-[#dc2626]" /> End
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
