import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Check, ChevronDown, LogOut, Maximize2, Network, Route as RouteIcon } from "lucide-react";
import { useModelData, useViewport, useViewerPose } from "@/state/infer-store";
import { continuousPolylineForStorey } from "@/lib/geometric-path";
import { buildStoreyNavmesh, regionAtPoint } from "@/lib/navmesh";
import {
  elevationsForVerticalRemap,
  normalizeElevationsToMetres,
} from "@/lib/storey-elevations";
import {
  ifcElevationFromThree,
  planHeadingFromThree,
  planTranslationFromCentres,
  pointInBuildingBounds,
  resolveCoordAxisFrame,
  storeyIdForElevation,
  threeAabbCentre,
  threeToIfcPlanResolved,
} from "@/lib/viewer-camera-pose";
import {
  IDENTITY_CAMERA,
  boundsFromPoints,
  cameraTransform,
  clientDeltaToPan,
  clientToView,
  nearestPortalWithin,
  toViewBox,
  viewHeight,
  viewWidth,
  type Camera,
  type PlanView,
  type Point2,
} from "@/lib/floorplan-camera";
import { cn } from "@/lib/utils";
import { useAppTheme, type AppTheme } from "@/hooks/use-app-theme";
import type { FootprintsDocument, Point2D } from "@/types/footprints";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FloorplanSvgLayers, PORTAL_COLORS, type PlanLayer } from "./FloorplanSvgLayers";
import { ShareRouteButton } from "./ShareRouteButton";
import { useNavmeshRouting } from "./useNavmeshRouting";

/** Same canvas colours as Graph Viewer (`graphPalette`). */
const PLAN_CANVAS = "bg-[#F8FAFC] dark:bg-[#0F1117]";
const PLAN_CANVAS_HEX: Record<AppTheme, string> = { light: "#F8FAFC", dark: "#0F1117" };

const GLASS =
  "rounded-[6px] border border-border bg-background/90 shadow-sm backdrop-blur-[2px]";

/**
 * Wall poché inverts light/dark rather than reusing one hex — the whole
 * point of solid architectural wall fill is maximum contrast against the
 * canvas, and a fixed color would go invisible (near-black walls on the
 * near-black dark canvas) or muddy the moment the theme flips.
 */
function floorplanPalette(theme: AppTheme) {
  return theme === "dark"
    ? { wall: "#cbd5e1", wallStroke: "#e2e8f0", label: "#e2e8f0", canvasBg: PLAN_CANVAS_HEX.dark }
    : { wall: "#1e293b", wallStroke: "#0f172a", label: "#1e293b", canvasBg: PLAN_CANVAS_HEX.light };
}

type PlanDisplayMode = "ifc" | "navmesh";

const DEFAULT_PLAN_LAYERS: Record<PlanLayer, boolean> = {
  spaces: true,
  walls: true,
  doors: true,
  stairs: true,
  route: true,
};

/** Google-Maps-style facing cone in plan metres (Y-up world, no SVG rotate). */
function headingConePath(
  x: number,
  y: number,
  heading: number,
  length: number,
  halfAngleRad: number,
): string {
  const steps = 16;
  const a0 = heading - halfAngleRad;
  const a1 = heading + halfAngleRad;
  let d = `M ${x} ${y}`;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    d += ` L ${x + Math.cos(a) * length} ${y + Math.sin(a) * length}`;
  }
  return `${d} Z`;
}

export function FloorplanViewer({ className }: { className?: string }) {
  const {
    footprintsDocument,
    entitiesExtract,
    connectivityGraph,
    connectivityRoute,
    navmeshRoute,
    setNavmeshRoute,
    excludedNodeIds,
    excludedEdgeIds,
  } = useModelData();
  const { activeStoreyId, setActiveStoreyId, selectedElementIds, selectElement } = useViewport();
  const { viewerCameraPose, viewerModelBounds, viewerCoordInverse } = useViewerPose();
  const theme = useAppTheme();
  const palette = useMemo(() => floorplanPalette(theme), [theme]);

  const [planDisplayMode, setPlanDisplayMode] = useState<PlanDisplayMode>("ifc");
  /** "route": click two points. "exit": click one point, auto-route to the nearest exit. */
  const [navmeshPickMode, setNavmeshPickMode] = useState<"route" | "exit">("route");
  /** Brief feedback for a right-click that missed every region. */
  const [missPick, setMissPick] = useState<Point2D | null>(null);
  const missPickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashMissPick = useCallback((point: Point2D) => {
    if (missPickTimerRef.current) clearTimeout(missPickTimerRef.current);
    setMissPick(point);
    missPickTimerRef.current = setTimeout(() => setMissPick(null), 500);
  }, []);

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
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  /** Right-press: short = place pin, long = clear route. */
  const rightPressRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    longFired: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const LONG_RIGHT_MS = 550;
  const draggingRef = useRef(false);
  const [layers, setLayers] = useState<Record<PlanLayer, boolean>>(DEFAULT_PLAN_LAYERS);

  const toggleLayer = useCallback((key: PlanLayer) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const footprintsId = footprintsDocument?.model_id ?? null;

  const {
    navmeshPathNote,
    isExitRoute,
    setIsExitRoute,
    blockedPortalIds,
    setBlockedPortalIds,
    allStoreyNavmeshes,
    clearNavmeshRoute,
  } = useNavmeshRouting({
    footprintsId,
    footprintsDocument,
    connectivityGraph,
    excludedNodeIds,
    excludedEdgeIds,
    navmeshRoute,
    setNavmeshRoute,
  });

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

  // Drop a stale storey id (e.g. after switching models) — but never "correct"
  // away from "all": that's a legitimate selection the 3D viewer also shares
  // this state with. Only genuinely invalid ids get normalized here.
  useEffect(() => {
    if (!storeys.length) return;
    if (activeStoreyId === "all") return;
    if (storeys.some((s) => s.global_id === activeStoreyId)) return;
    const first = storeys[0];
    if (first) setActiveStoreyId(first.global_id);
  }, [storeys, activeStoreyId, setActiveStoreyId]);

  // Floorplan can only ever render one storey at a time — when the shared
  // selection is "all" (a valid, 3D-only concept), fall back to the first
  // storey for THIS pane's own display without touching the shared state.
  const displayStoreyId = useMemo(() => {
    if (activeStoreyId !== "all" && storeys.some((s) => s.global_id === activeStoreyId)) {
      return activeStoreyId;
    }
    return storeys[0]?.global_id ?? null;
  }, [activeStoreyId, storeys]);

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
    const modelHeightM = viewerModelBounds
      ? viewerModelBounds.maxY - viewerModelBounds.minY
      : undefined;
    const { metres } = normalizeElevationsToMetres(
      withElev.map((s) => s.elevation),
      modelHeightM,
    );
    return withElev.map((s, i) => ({
      global_id: s.global_id,
      elevation: metres[i]!,
    }));
  }, [footprintsDocument, viewerModelBounds]);

  /** Elevations for Three↔IFC height remap (exclude empty datum storeys). */
  const remapElevationsM = useMemo(() => {
    if (!footprintsDocument) return storeysMetres.map((s) => s.elevation);
    return elevationsForVerticalRemap(
      storeysMetres,
      footprintsDocument.spaces
        .filter((s) => !s.incomplete && s.polygon.length >= 3)
        .map((s) => s.storey_global_id),
    );
  }, [footprintsDocument, storeysMetres]);

  /**
   * Axis reading for coordination-undone coords, resolved once per model.
   * Deciding this per camera sample let the dot flip frames mid-walk.
   */
  const coordAxisFrame = useMemo(
    () =>
      resolveCoordAxisFrame(
        viewerCoordInverse ?? null,
        viewerModelBounds ?? null,
        footprintBoundsTight,
      ),
    [viewerCoordInverse, viewerModelBounds, footprintBoundsTight],
  );

  /**
   * Whether camera height comes from the coordination matrix or from the mesh
   * remap. Model-level so it cannot change as the camera moves.
   */
  const useMeshElevation = useMemo(() => {
    if (!viewerCoordInverse || viewerCoordInverse.length < 16) return true;
    if (!viewerModelBounds || !storeysMetres.length) return false;
    // Probe the mesh floor and ceiling through the matrix; if neither lands in
    // a storey band, the matrix Z pack is unusable for this model.
    const probes = [viewerModelBounds.minY, viewerModelBounds.maxY].map((y) =>
      threeToIfcPlanResolved(
        { x: 0, y, z: 0 },
        viewerCoordInverse,
        null,
        coordAxisFrame,
      ).elevation,
    );
    return !probes.some((e) => storeyIdForElevation(storeysMetres, e) != null);
  }, [viewerCoordInverse, viewerModelBounds, storeysMetres, coordAxisFrame]);

  /**
   * 3D camera as plan blue dot: only when inside the building footprint AABB
   * and on the storey currently shown (or any storey when viewing "all").
   *
   * Every mapping choice (axis frame, elevation source, centre delta) is
   * resolved per model, never per camera sample — otherwise the dot flips
   * interpretation partway across a floor and vanishes.
   */
  const cameraDotInfo = useMemo(() => {
    if (!viewerCameraPose) {
      return {
        dot: null as { x: number; y: number; heading: number } | null,
        reason: "no 3D pose yet",
      };
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
      const d = planTranslationFromCentres(
        threeAabbCentre(viewerModelBounds),
        footprintBoundsTight,
      );
      planDeltaRef.current =
        Math.abs(d.x) < 0.05 && Math.abs(d.y) < 0.05 ? { x: 0, y: 0 } : d;
    }

    if (!hasCoord && planDeltaRef.current == null && footprintBoundsTight) {
      return { dot: null, reason: "calibrating plan ↔ 3D origin…" };
    }

    const coord = hasCoord ? viewerCoordInverse : null;
    const delta = hasCoord ? null : planDeltaRef.current;
    const mapped = threeToIfcPlanResolved(three, coord, delta, coordAxisFrame);

    const meshElev =
      viewerModelBounds && remapElevationsM.length
        ? ifcElevationFromThree(three.y, viewerModelBounds, remapElevationsM)
        : null;

    const elev =
      useMeshElevation && meshElev != null ? meshElev : mapped.elevation;

    const plan = { x: mapped.x, y: mapped.y, elevation: elev };

    if (!pointInBuildingBounds(plan.x, plan.y, buildingBounds)) {
      return {
        dot: null,
        reason: "outside building — fly inside to see the camera dot",
      };
    }
    if (storeysMetres.length) {
      const poseStorey = storeyIdForElevation(storeysMetres, plan.elevation);
      if (!poseStorey || poseStorey !== displayStoreyId) {
        const name =
          storeys.find((s) => s.global_id === poseStorey)?.name ?? poseStorey ?? "?";
        return {
          dot: null,
          reason: `camera on ${name} — switch floorplan level to match`,
        };
      }
    }
    const forward = viewerCameraPose.forward ?? { x: 0, y: 0, z: -1 };
    const heading = planHeadingFromThree(
      three,
      forward,
      coord,
      delta,
      coordAxisFrame,
    );
    return { dot: { x: plan.x, y: plan.y, heading }, reason: "tracking" };
  }, [
    viewerCameraPose,
    viewerModelBounds,
    viewerCoordInverse,
    buildingBounds,
    footprintBoundsTight,
    storeysMetres,
    remapElevationsM,
    coordAxisFrame,
    useMeshElevation,
    displayStoreyId,
    storeys,
  ]);
  const cameraDot = cameraDotInfo.dot;
  const applyCameraDom = useCallback(() => {
    const g = cameraGroupRef.current;
    const bounds = boundsRef.current;
    if (!g || !bounds) return;
    const cam = cameraRef.current;
    g.setAttribute("transform", cameraTransform(bounds, cam));
    // Keep camera + route pins constant on screen (counter parent zoom).
    const inv = 1 / Math.max(cam.zoom, 1e-6);
    g.querySelectorAll(".infer-screen-fixed-scale").forEach((el) => {
      const flip = el.getAttribute("data-yflip") === "1";
      el.setAttribute("transform", flip ? `scale(${inv},${-inv})` : `scale(${inv})`);
    });
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
    return footprintsDocument.spaces.filter(
      (s) => s.storey_global_id === displayStoreyId && keep(s),
    );
  }, [footprintsDocument, displayStoreyId, excludedNodeIds]);

  const doors = useMemo(() => {
    if (!footprintsDocument) return [];
    return footprintsDocument.doors.filter(
      (d) => d.storey_global_id === displayStoreyId && d.point && !d.incomplete,
    );
  }, [footprintsDocument, displayStoreyId]);

  /** For the Navmesh view's faint supplementary swing glyph under each door portal dot. */
  const doorsByGlobalId = useMemo(() => {
    const map = new Map<string, (typeof doors)[number]>();
    for (const d of footprintsDocument?.doors ?? []) map.set(d.global_id, d);
    return map;
  }, [footprintsDocument]);

  /**
   * Stairs often sit on one containment storey but represent a vertical shaft.
   * Show on matching storey; if unassigned, show on every storey so they aren't lost.
   */
  const stairs = useMemo(() => {
    const list = footprintsDocument?.stairs ?? [];
    return list.filter((s) => {
      if (s.incomplete || s.polygon.length < 3) return false;
      if (excludedNodeIds.has(`stair:${s.global_id}`)) return false;
      if (s.storey_global_id == null) return true;
      return s.storey_global_id === displayStoreyId;
    });
  }, [footprintsDocument, displayStoreyId, excludedNodeIds]);

  /** Walls: match storey when known; unassigned walls show on every storey. */
  const walls = useMemo(() => {
    const list = footprintsDocument?.walls ?? [];
    return list.filter((w) => {
      if (w.incomplete || w.polygon.length < 3) return false;
      if (w.storey_global_id == null) return true;
      return w.storey_global_id === displayStoreyId;
    });
  }, [footprintsDocument, displayStoreyId]);

  const overlay = useMemo(() => {
    if (!footprintsDocument || !connectivityRoute?.found || !displayStoreyId) return null;
    return continuousPolylineForStorey(
      connectivityRoute.node_ids,
      footprintsDocument,
      displayStoreyId,
      connectivityGraph,
    );
  }, [
    footprintsDocument,
    connectivityRoute,
    displayStoreyId,
    connectivityGraph,
  ]);

  /** Graph / inspector selection → blue room fill(s) on the plan. */
  const selectedSpaces = useMemo(() => {
    if (!footprintsDocument || !selectedElementIds.length) return [];
    const out = [];
    for (const raw of selectedElementIds) {
      if (excludedNodeIds.has(raw)) continue;
      const gid = raw.startsWith("space:") ? raw.slice("space:".length) : raw;
      if (excludedNodeIds.has(`space:${gid}`)) continue;
      const space = footprintsDocument.spaces.find((s) => s.global_id === gid);
      if (!space || space.incomplete || space.polygon.length < 3) continue;
      const onStorey =
        space.storey_global_id == null || space.storey_global_id === displayStoreyId;
      if (onStorey) out.push(space);
    }
    return out;
  }, [footprintsDocument, selectedElementIds, displayStoreyId, excludedNodeIds]);

  const storeyNavmesh = useMemo(() => {
    if (!footprintsDocument || !connectivityGraph || !displayStoreyId) {
      return null;
    }
    return buildStoreyNavmesh(footprintsDocument, connectivityGraph, displayStoreyId, {
      excludedNodeIds,
      excludedEdgeIds,
    });
  }, [
    footprintsDocument,
    connectivityGraph,
    displayStoreyId,
    excludedNodeIds,
    excludedEdgeIds,
  ]);

  const navmeshStart =
    navmeshRoute && navmeshRoute.storeyId === displayStoreyId ? navmeshRoute.start : null;
  const navmeshEnd =
    navmeshRoute && navmeshRoute.end && navmeshRoute.endStoreyId === displayStoreyId
      ? navmeshRoute.end
      : null;

  const activeStoreyLabel = useMemo(() => {
    if (!storeys.length) return "No storeys";
    const match = storeys.find((s) => s.global_id === displayStoreyId);
    if (!match) return "Select storey";
    const name =
      match.name?.trim() ||
      (match.elevation != null ? `E${match.elevation}` : match.global_id.slice(0, 8));
    // The 3D viewer can show "All levels" while Floorplan can only ever
    // display one storey at a time — say which one so it's clear this is a
    // fallback, not the actual shared selection.
    return activeStoreyId === "all" ? `${name} (of all levels)` : name;
  }, [storeys, activeStoreyId, displayStoreyId]);

  const activeRouteSegmentPoints: Point2D[] | undefined =
    navmeshRoute?.storeyId === displayStoreyId && navmeshRoute.points?.length
      ? navmeshRoute.points
      : navmeshRoute?.segments?.find((s) => s.storeyId === displayStoreyId)?.points;
  const pathPoints: Point2D[] = activeRouteSegmentPoints?.length
    ? activeRouteSegmentPoints
    : (overlay?.points ?? []);
  const viewBox = buildingBounds ? toViewBox(buildingBounds) : "0 0 10 10";

  // Stroke widths in world metres (fraction of building size). Avoid
  // vector-effect:non-scaling-stroke — under scale(1,-1) it desyncs strokes
  // from fills (brown door ring offset, grey outline ≠ polygon).
  const markerBase = buildingBounds
    ? Math.max(viewWidth(buildingBounds), viewHeight(buildingBounds))
    : 10;
  const roomStroke = markerBase * 0.0012;
  const selectedStroke = markerBase * 0.0024;
  const routeStroke = markerBase * 0.004;
  const routeHalo = markerBase * 0.008;
  const doorR = markerBase * 0.008;
  const doorStroke = markerBase * 0.0015;
  const doorGlyphStroke = markerBase * 0.0025;
  const portalR = markerBase * 0.01;
  const cameraR = markerBase * 0.018;
  // Pin bulb ≈ 1.3× portal diameter — tip-to-top ~2× that.
  const pinScale = portalR * 2.5;
  const pinHitR = Math.max(pinScale * 1.4, portalR * 2.2);
  const portalHitR = portalR * 2.5;

  const navmeshPickRef = useRef({
    enabled: false as boolean,
    mesh: null as ReturnType<typeof buildStoreyNavmesh> | null,
    mode: "route" as "route" | "exit",
    footprints: null as FootprintsDocument | null,
    // Raw start pin + its storey, ungated by which floor is currently shown —
    // the end pin can be placed on a different floor, so "is a pin pending"
    // must not depend on `activeStoreyId`.
    startPoint: null as Point2 | null,
    startStoreyId: null as string | null,
    hasEnd: false as boolean,
    hasRoute: false as boolean,
    pinHitR: 1,
    portalHitR: 1,
    storeyId: "" as string,
  });
  navmeshPickRef.current = {
    enabled: planDisplayMode === "navmesh" && storeyNavmesh != null,
    mesh: storeyNavmesh,
    mode: navmeshPickMode,
    footprints: footprintsDocument,
    startPoint: navmeshRoute?.start ?? null,
    startStoreyId: navmeshRoute?.storeyId ?? null,
    hasEnd: navmeshRoute?.end != null,
    hasRoute: navmeshRoute != null,
    pinHitR,
    portalHitR,
    storeyId: displayStoreyId ?? "",
  };

  const selectElementRef = useRef(selectElement);
  selectElementRef.current = selectElement;

  const incompleteCount =
    footprintsDocument?.spaces.filter((s) => s.incomplete).length ?? 0;

  const pathD =
    pathPoints.length >= 2
      ? pathPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")
      : "";

  const navmeshStatusParts: string[] = [];
  if (planDisplayMode === "navmesh" && storeyNavmesh) {
    navmeshStatusParts.push(
      `${storeyNavmesh.regions.length} regions · ${storeyNavmesh.portals.length} portals`,
    );
  }
  if (planDisplayMode === "navmesh" && navmeshRoute && !navmeshRoute.end) {
    if (navmeshPickMode === "exit") {
      navmeshStatusParts.push("right-click a point to route to the nearest exit");
    } else {
      navmeshStatusParts.push(
        navmeshRoute.storeyId === displayStoreyId
          ? "right-click end point"
          : "right-click end point (start pin is on another floor)",
      );
    }
  }
  if (navmeshPathNote) navmeshStatusParts.push(navmeshPathNote);
  if (navmeshRoute?.end) {
    navmeshStatusParts.push(
      navmeshPickMode === "exit"
        ? "long right-click to clear · right-click elsewhere for a new exit"
        : "long right-click to clear",
    );
  }
  if (!navmeshRoute?.points && !navmeshRoute?.segments && connectivityRoute?.found) {
    const note =
      pathPoints.length >= 2
        ? overlay?.note
        : overlay?.note || "Route has no drawable points on this storey";
    if (note) navmeshStatusParts.push(note);
  }
  const navmeshStatusMessage = navmeshStatusParts.join(" · ");

  // Restore camera transform after React commits geometry (do not put transform in JSX —
  // React re-renders were wiping pan/zoom). Skip while dragging so layout can't fight the gesture.
  // Also re-apply screen-fixed marker scales when pins / camera dot mount.
  useLayoutEffect(() => {
    if (draggingRef.current) return;
    applyCameraDom();
  }, [
    applyCameraDom,
    buildingBounds,
    displayStoreyId,
    footprintsId,
    navmeshStart?.x,
    navmeshStart?.y,
    navmeshEnd?.x,
    navmeshEnd?.y,
    cameraDot?.x,
    cameraDot?.y,
    cameraDot?.heading,
    missPick?.x,
    missPick?.y,
  ]);

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

    const clearRightPress = () => {
      const rp = rightPressRef.current;
      if (rp?.timer != null) clearTimeout(rp.timer);
      rightPressRef.current = null;
    };

    const placeNavmeshPin = (clientX: number, clientY: number) => {
      const pick = navmeshPickRef.current;
      if (!pick.enabled || !pick.mesh || !pick.storeyId) return;
      // Route mode locks after two clicks (clear to restart); exit mode is a
      // repeatable one-shot tool — every click starts a fresh search.
      if (pick.mode === "route" && pick.startPoint && pick.hasEnd) return;
      const bounds = boundsRef.current;
      const svg = svgRef.current;
      if (!bounds || !svg) return;
      const world = clientToView(clientX, clientY, svg, bounds, cameraRef.current);
      if (!regionAtPoint(pick.mesh, world)) {
        flashMissPick(world);
        return;
      }

      if (pick.mode === "exit") {
        // Actual nearest-exit search happens in the recompute effect (single
        // source of truth for pathfinding), keyed off this start point.
        setIsExitRoute(true);
        setNavmeshRoute({
          storeyId: pick.storeyId,
          start: { x: world.x, y: world.y },
          end: null,
          endStoreyId: null,
          points: null,
          segments: null,
        });
        return;
      }

      if (!pick.startPoint) {
        setIsExitRoute(false);
        setNavmeshRoute({
          storeyId: pick.storeyId,
          start: { x: world.x, y: world.y },
          end: null,
          endStoreyId: null,
          points: null,
          segments: null,
        });
        return;
      }
      // End pin may land on a different storey than the start (the user
      // switched floors after placing it) — findMultiStoreyNavmeshPath picks
      // that up via the effect above.
      setNavmeshRoute({
        storeyId: pick.startStoreyId!,
        start: pick.startPoint,
        end: { x: world.x, y: world.y },
        endStoreyId: pick.storeyId,
        points: null,
        segments: null,
      });
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0) {
        e.preventDefault();
        draggingRef.current = true;
        surface.setPointerCapture(e.pointerId);
        dragRef.current = {
          pointerId: e.pointerId,
          lastX: e.clientX,
          lastY: e.clientY,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
        return;
      }

      if (e.button !== 2) return;
      e.preventDefault();
      clearRightPress();
      const timer = setTimeout(() => {
        const rp = rightPressRef.current;
        if (!rp || rp.pointerId !== e.pointerId) return;
        rp.longFired = true;
        // Long right-press clears pins + path (anywhere on the plan, any storey).
        if (navmeshPickRef.current.hasRoute) {
          clearNavmeshRoute();
        }
      }, LONG_RIGHT_MS);
      rightPressRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        longFired: false,
        timer,
      };
      try {
        surface.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const rp = rightPressRef.current;
      if (rp && rp.pointerId === e.pointerId) {
        const dx = e.clientX - rp.startX;
        const dy = e.clientY - rp.startY;
        if (!rp.moved && dx * dx + dy * dy > 25) rp.moved = true;
      }

      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const bounds = boundsRef.current;
      const svg = svgRef.current;
      if (!bounds || !svg) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && dx * dx + dy * dy > 16) drag.moved = true;

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

    const endPointer = (e: PointerEvent) => {
      const rp = rightPressRef.current;
      if (rp && rp.pointerId === e.pointerId) {
        const longFired = rp.longFired;
        const moved = rp.moved;
        clearRightPress();
        try {
          if (surface.hasPointerCapture(e.pointerId)) {
            surface.releasePointerCapture(e.pointerId);
          }
        } catch {
          /* ignore */
        }
        // Short right-click on a region → start then end pin.
        if (!longFired && !moved) {
          placeNavmeshPin(e.clientX, e.clientY);
        }
        return;
      }

      if (dragRef.current?.pointerId !== e.pointerId) return;
      const drag = dragRef.current;
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

      // Left-click (not pan): a portal toggles blocked (hazard what-if);
      // otherwise a region toggles graph/floorplan selection.
      if (!drag || drag.moved) return;
      const pick = navmeshPickRef.current;
      if (!pick.enabled || !pick.mesh) return;
      const bounds = boundsRef.current;
      const svg = svgRef.current;
      if (!bounds || !svg) return;
      const world = clientToView(e.clientX, e.clientY, svg, bounds, cameraRef.current);
      const portal = nearestPortalWithin(pick.mesh.portals, world, pick.portalHitR);
      if (portal) {
        setBlockedPortalIds((prev) => {
          const next = new Set(prev);
          if (next.has(portal.id)) next.delete(portal.id);
          else next.add(portal.id);
          return next;
        });
        return;
      }
      const region = regionAtPoint(pick.mesh, world);
      if (!region) return;
      selectElementRef.current(region.spaceId);
    };

    const onContextMenu = (e: MouseEvent) => {
      // Always suppress browser menu; short/long right-press handled above.
      e.preventDefault();
    };

    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", endPointer);
    surface.addEventListener("pointercancel", endPointer);
    surface.addEventListener("contextmenu", onContextMenu);
    return () => {
      clearRightPress();
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", endPointer);
      surface.removeEventListener("pointercancel", endPointer);
      surface.removeEventListener("contextmenu", onContextMenu);
      dragRef.current = null;
      draggingRef.current = false;
    };
  }, [
    footprintsId,
    footprintsDocument,
    applyCameraDom,
    clearNavmeshRoute,
    setNavmeshRoute,
    flashMissPick,
    setIsExitRoute,
    setBlockedPortalIds,
  ]);

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col", PLAN_CANVAS, className)}>
      <div className={cn("relative min-h-0 flex-1", PLAN_CANVAS)}>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-3">
          <div className="pointer-events-auto flex flex-col items-start gap-1.5">
            <div className={cn(GLASS, "flex overflow-hidden")}>
              <button
                type="button"
                onClick={() => setPlanDisplayMode("ifc")}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] transition-colors",
                  planDisplayMode === "ifc"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
                title="Show floorplan geometry"
              >
                <Box className="size-3.5" aria-hidden />
                Floorplan
              </button>
              <button
                type="button"
                onClick={() => setPlanDisplayMode("navmesh")}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] transition-colors",
                  planDisplayMode === "navmesh"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
                title="Show portal navmesh for this level"
              >
                <Network className="size-3.5" aria-hidden />
                Navmesh
              </button>
            </div>

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
                  const active = displayStoreyId === s.global_id;
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

            {planDisplayMode === "navmesh" ? (
              <div className={cn(GLASS, "flex overflow-hidden")}>
                <button
                  type="button"
                  onClick={() => {
                    setNavmeshPickMode("route");
                    clearNavmeshRoute();
                  }}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] transition-colors",
                    navmeshPickMode === "route"
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                  title="Right-click two points to route between them"
                >
                  <RouteIcon className="size-3.5" aria-hidden />
                  Route
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNavmeshPickMode("exit");
                    clearNavmeshRoute();
                  }}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] transition-colors",
                    navmeshPickMode === "exit"
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                  title="Right-click a point to route to the nearest exit on this level"
                >
                  <LogOut className="size-3.5" aria-hidden />
                  Nearest exit
                </button>
              </div>
            ) : null}

            <ShareRouteButton navmeshRoute={navmeshRoute} footprintsDocument={footprintsDocument} />
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
                  <FloorplanSvgLayers
                    planDisplayMode={planDisplayMode}
                    layers={layers}
                    walls={walls}
                    spaces={spaces}
                    stairs={stairs}
                    doors={doors}
                    storeyNavmesh={storeyNavmesh}
                    pathD={pathD}
                    navmeshStart={navmeshStart}
                    navmeshEnd={navmeshEnd}
                    isExitRoute={isExitRoute}
                    blockedPortalIds={blockedPortalIds}
                    doorsByGlobalId={doorsByGlobalId}
                    palette={palette}
                    selectedSpaces={selectedSpaces}
                    roomStroke={roomStroke}
                    markerBase={markerBase}
                    doorR={doorR}
                    doorStroke={doorStroke}
                    doorGlyphStroke={doorGlyphStroke}
                    portalR={portalR}
                    pinScale={pinScale}
                    routeHalo={routeHalo}
                    routeStroke={routeStroke}
                    selectedStroke={selectedStroke}
                  />

                  {cameraDot ? (
                    <g
                      className="infer-screen-fixed"
                      transform={`translate(${cameraDot.x} ${cameraDot.y})`}
                    >
                      <g className="infer-screen-fixed-scale" transform="scale(1)">
                        {/* Facing cone first (under the disc), Google Maps style. */}
                        <path
                          d={headingConePath(
                            0,
                            0,
                            cameraDot.heading,
                            cameraR * 4.2,
                            (58 * Math.PI) / 180,
                          )}
                          fill="rgba(66,133,244,0.38)"
                          stroke="none"
                        />
                        <circle
                          cx={0}
                          cy={0}
                          r={cameraR * 1.35}
                          fill="#ffffff"
                          stroke="none"
                        />
                        <circle
                          cx={0}
                          cy={0}
                          r={cameraR}
                          fill="#4285F4"
                          stroke="#ffffff"
                          strokeWidth={doorStroke * 0.6}
                        >
                          <title>3D camera</title>
                        </circle>
                      </g>
                    </g>
                  ) : null}

                  {missPick ? (
                    <g
                      className="infer-screen-fixed"
                      transform={`translate(${missPick.x} ${missPick.y})`}
                    >
                      <g className="infer-screen-fixed-scale" transform="scale(1)">
                        <circle
                          cx={0}
                          cy={0}
                          r={portalR * 1.8}
                          fill="none"
                          stroke="#ef4444"
                          strokeWidth={doorStroke * 0.7}
                          opacity={0.85}
                        />
                        <path
                          d={`M${-portalR * 0.9} ${-portalR * 0.9} L${portalR * 0.9} ${portalR * 0.9} M${-portalR * 0.9} ${portalR * 0.9} L${portalR * 0.9} ${-portalR * 0.9}`}
                          stroke="#ef4444"
                          strokeWidth={doorStroke * 0.9}
                          strokeLinecap="round"
                        >
                          <title>No walkable region here — click inside a room</title>
                        </path>
                      </g>
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
              title={
                planDisplayMode === "navmesh"
                  ? "Left-click region: select/deselect space. Left-click a portal: block/unblock it. Right-click: set start then end. Long right-click: clear pins and path. Drag to pan."
                  : undefined
              }
            />

            {spaces.length === 0 && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center px-4 text-center text-xs text-muted-foreground">
                No complete footprints on this storey
                {incompleteCount > 0 ? ` (${incompleteCount} incomplete in model)` : ""}.
                IFC spaces need placement or mesh geometry.
              </div>
            )}

            <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-20 flex flex-wrap items-center gap-1.5 rounded-md border border-border/80 bg-background/90 px-2 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
              {planDisplayMode === "navmesh" ? (
                <>
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground">
                    <span
                      className="inline-block size-2.5 border border-[#64748b]"
                      style={{ background: "rgba(148,163,184,0.35)" }}
                    />
                    Region
                  </span>
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: PORTAL_COLORS.door }}
                    />
                    IFC door
                  </span>
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: PORTAL_COLORS.doorHeal }}
                    />
                    Door heal
                  </span>
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: PORTAL_COLORS.spacePortal }}
                    />
                    Space portal
                  </span>
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: PORTAL_COLORS.exit }}
                    />
                    Exit
                  </span>
                </>
              ) : null}
              {(
                (
                  planDisplayMode === "ifc"
                    ? ([
                        {
                          key: "route" as const,
                          label: "Route",
                          swatch: <span className="inline-block h-0.5 w-4 bg-[#1d4ed8]" />,
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
                              className="inline-block size-2.5 border"
                              style={{
                                background: palette.wall,
                                borderColor: palette.wallStroke,
                              }}
                            />
                          ),
                        },
                        {
                          key: "doors" as const,
                          label: "Door",
                          swatch: (
                            <span className="inline-block h-1.5 w-3 rounded-[1px] bg-[#f59e0b]" />
                          ),
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
                      ] as const)
                    : ([
                        {
                          key: "route" as const,
                          label: "Route",
                          swatch: <span className="inline-block h-0.5 w-4 bg-[#1d4ed8]" />,
                        },
                      ] as const)
                )
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
              {planDisplayMode === "navmesh" && blockedPortalIds.size > 0 ? (
                <button
                  type="button"
                  className="pointer-events-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground transition-colors hover:bg-muted"
                  title="Clear all blocked portals"
                  onClick={() => setBlockedPortalIds(new Set())}
                >
                  <span className="inline-block size-2 rounded-full bg-[#94a3b8]" />
                  {blockedPortalIds.size} blocked · clear
                </button>
              ) : null}
              <span className="min-w-0 basis-full px-1" title={navmeshStatusMessage || undefined}>
                {navmeshStatusMessage}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
