import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  Check,
  ChevronDown,
  Flame,
  FolderOpen,
  Layers,
  LogOut,
  Maximize2,
  Network,
  Route as RouteIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useModelData,
  useViewport,
  useViewerPose,
  type EvacuationLoadMarker,
} from "@/state/infer-store";
import { continuousPolylineForStorey, pointInSpace } from "@/lib/geometric-path";
import { buildStoreyNavmesh, regionAtPoint, type BuildingEvacuationLoadResult } from "@/lib/navmesh";
import { computeBuildingEvacuationLoadAsync } from "@/lib/navmesh-worker-client";
import type { FootprintsDocument, Point2D, SpaceFootprint } from "@/types/footprints";
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
  normalizeRotation,
  panDeltaForRotationAt,
  panDeltaForZoomAt,
  toViewBox,
  viewHeight,
  viewWidth,
  type Camera,
  type PlanView,
  type Point2,
} from "@/lib/floorplan-camera";
import { cn } from "@/lib/utils";
import { GLASS } from "@/lib/floating-panel";
import { useAppTheme, type AppTheme } from "@/hooks/use-app-theme";
import type { GraphNode } from "@/types/graph";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  evacuationHeatColor,
  FloorplanSvgLayers,
  PORTAL_COLORS,
  type PlanLayer,
} from "./FloorplanSvgLayers";
import { useNavmeshRouting } from "./useNavmeshRouting";

/** Same canvas colours as Graph Viewer (`graphPalette`). */
const PLAN_CANVAS = "bg-[#F8FAFC] dark:bg-[#0F1117]";
const PLAN_CANVAS_HEX: Record<AppTheme, string> = { light: "#F8FAFC", dark: "#0F1117" };

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
  furniture: true,
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

/**
 * Raw footprint hit-testing for plain-tab room selection — deliberately NOT
 * storeyNavmesh-based so an excluded room can still be inspected. Nested
 * parents: when the parent is still in the model it wins (largest
 * containing footprint); once removed, children under it become hittable.
 */
function footprintPlanArea(space: SpaceFootprint): number {
  let area = 0;
  const ring = space.polygon;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) * 0.5;
  for (const hole of space.holes ?? []) {
    let holeArea = 0;
    for (let i = 0, j = hole.length - 1; i < hole.length; j = i++) {
      const a = hole[i]!;
      const b = hole[j]!;
      holeArea += a.x * b.y - b.x * a.y;
    }
    area = Math.max(0, area - Math.abs(holeArea) * 0.5);
  }
  return area;
}

function spaceAtWorldPoint(
  world: Point2D,
  footprints: FootprintsDocument | null,
  storeyId: string,
  excludedNodeIds?: ReadonlySet<string>,
): { global_id: string; name: string } | null {
  if (!footprints) return null;
  const containing: SpaceFootprint[] = [];
  for (const s of footprints.spaces) {
    if (s.incomplete || s.polygon.length < 3) continue;
    if (s.storey_global_id !== storeyId) continue;
    if (!pointInSpace(world.x, world.y, s.polygon, s.holes)) continue;
    containing.push(s);
  }
  if (!containing.length) return null;

  const excluded = excludedNodeIds ?? new Set<string>();
  const active = containing.filter((s) => !excluded.has(`space:${s.global_id}`));
  // Prefer live spaces; only fall back to excluded so a removed parent can
  // still be re-selected from empty parent area (no child under the click).
  const pool = active.length > 0 ? active : containing;

  let best = pool[0]!;
  let bestArea = footprintPlanArea(best);
  for (let i = 1; i < pool.length; i++) {
    const s = pool[i]!;
    const area = footprintPlanArea(s);
    if (area > bestArea) {
      best = s;
      bestArea = area;
    }
  }
  return best;
}

export function FloorplanViewer({ className }: { className?: string }) {
  const {
    footprintsDocument,
    entitiesExtract,
    connectivityGraph,
    connectivityRoute,
    navmeshRoute,
    setNavmeshRoute,
    setEvacuationLoadMarkers,
    setViewerFocusRequest,
    excludedNodeIds,
    excludedEdgeIds,
  } = useModelData();
  const {
    activeStoreyId,
    setActiveStoreyId,
    selectedElementIds,
    selectElement,
    setIngestOpen,
    // Shared with InferModelViewport for evacuation-load markers only —
    // storey filters are independent per pane.
    showEvacuationLoad,
    setShowEvacuationLoad,
  } = useViewport();
  const { viewerCameraPose, viewerModelBounds, viewerCoordInverse } = useViewerPose();
  const theme = useAppTheme();
  const palette = useMemo(() => floorplanPalette(theme), [theme]);

  // computeBuildingEvacuationLoad (a Dijkstra over the whole building) runs
  // in a Web Worker (see buildingEvacuationLoad below and
  // navmesh-worker-client.ts) rather than inline — on a real large building
  // this is expensive enough to freeze the tab for its duration if run
  // synchronously during render (see navmesh.test.ts's "stays fast for a
  // tall building" perf test for the shape of the cost). isEvacuationLoadPending
  // now tracks that worker call directly instead of going through
  // React's startTransition, which only reprioritized the resulting
  // render — it never stopped the synchronous call itself from blocking.
  const [isEvacuationLoadPending, setIsEvacuationLoadPending] = useState(false);

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
    /** Alt+drag rotates the plan about the cursor instead of panning. */
    mode: "pan" | "rotate";
    /** World point under the cursor at rotate-gesture start (kept fixed). */
    pivot: Point2 | null;
    /** Previous screen angle about the orbit centre (radians), or null until the first sample. */
    lastAngle: number | null;
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
    navmeshBusy,
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
    // Keep pins constant on screen (counter parent zoom + rotation). The 3D
    // camera cone keeps world orientation so its heading still matches the plan.
    const inv = 1 / Math.max(cam.zoom, 1e-6);
    const deg = (-cam.rotation * 180) / Math.PI;
    g.querySelectorAll(".infer-screen-fixed-scale").forEach((el) => {
      const flip = el.getAttribute("data-yflip") === "1";
      const worldOrient = el.getAttribute("data-world-orient") === "1";
      if (worldOrient) {
        el.setAttribute("transform", flip ? `scale(${inv},${-inv})` : `scale(${inv})`);
      } else {
        el.setAttribute(
          "transform",
          flip ? `rotate(${deg}) scale(${inv},${-inv})` : `rotate(${deg}) scale(${inv})`,
        );
      }
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

  // Excluded rooms stay in this list (rendered dashed via `excludedNodeIds`
  // in the SVG layer) rather than vanishing — soft-exclude from the Inspector
  // or Graph Viewer keeps them visible instead of deleting from the layout.
  const spaces = useMemo(() => {
    if (!footprintsDocument) return [];
    return footprintsDocument.spaces.filter(
      (s) => s.storey_global_id === displayStoreyId && !s.incomplete && s.polygon.length >= 3,
    );
  }, [footprintsDocument, displayStoreyId]);

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

  /** Furniture: same storey-matching rule as walls. */
  const furniture = useMemo(() => {
    const list = footprintsDocument?.furniture ?? [];
    // Null-storey furniture used to be drawn on *every* floor ("if null,
    // show everywhere"). Most IFC furniture isn't spatially contained in a
    // storey, so that dumped the whole building's desks onto each plan.
    // Only draw items that actually match the selected storey; backend now
    // fills storey from mesh Z when containment is missing (re-ingest).
    return list.filter(
      (item) =>
        item.storey_global_id === displayStoreyId && !item.incomplete && item.polygon.length >= 3,
    );
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

  /** Graph / inspector selection → sky room fill(s) on the plan. */
  const selectedSpaces = useMemo(() => {
    if (!footprintsDocument || !selectedElementIds.length) return [];
    const out = [];
    for (const raw of selectedElementIds) {
      if (raw.startsWith("portal:")) continue;
      const gid = raw.startsWith("space:") ? raw.slice("space:".length) : raw;
      const space = footprintsDocument.spaces.find((s) => s.global_id === gid);
      if (!space || space.incomplete || space.polygon.length < 3) continue;
      const onStorey =
        space.storey_global_id == null || space.storey_global_id === displayStoreyId;
      if (onStorey) out.push(space);
    }
    return out;
  }, [footprintsDocument, selectedElementIds, displayStoreyId]);

  /** Portal selection ids (`portal:<navmeshPortalId>`) → blue outline on markers. */
  const selectedPortalIds = useMemo(() => {
    const set = new Set<string>();
    for (const raw of selectedElementIds) {
      if (raw.startsWith("portal:")) set.add(raw.slice("portal:".length));
    }
    return set;
  }, [selectedElementIds]);

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

  // Only computed while the overlay is actually on — it's a Dijkstra run
  // over the *whole building's* portal graph, not a one-off route. Shares
  // blockedPortalIds with the hazard what-if state on purpose: blocking a
  // door as a "what if this exit failed" test should shift the bottleneck
  // heat map too, not require a second, disconnected control.
  //
  // Building-wide (computeBuildingEvacuationLoad over every storey), not
  // per-storey (computeEvacuationLoad) — a room upstairs that reaches a
  // stairwell has its route actually continue down through it to a real
  // exit, so a ground-floor lobby door's count reflects everyone funnelling
  // through it from upper floors too, not just that floor's own rooms.
  const [buildingEvacuationLoad, setBuildingEvacuationLoad] =
    useState<BuildingEvacuationLoadResult | null>(null);

  useEffect(() => {
    if (!showEvacuationLoad || !allStoreyNavmeshes.length) {
      setBuildingEvacuationLoad(null);
      setIsEvacuationLoadPending(false);
      return;
    }
    let cancelled = false;
    setIsEvacuationLoadPending(true);
    void computeBuildingEvacuationLoadAsync(allStoreyNavmeshes, footprintsDocument, connectivityGraph, {
      blockedPortalIds,
    })
      .then((result) => {
        if (cancelled) return;
        setBuildingEvacuationLoad(result);
        setIsEvacuationLoadPending(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Evacuation load failed", err);
        setBuildingEvacuationLoad(null);
        setIsEvacuationLoadPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showEvacuationLoad, allStoreyNavmeshes, footprintsDocument, connectivityGraph, blockedPortalIds]);

  // The floorplan pane only ever shows one storey's plan at a time, so
  // stair markers (which carry a storeyId, unlike real portals which are
  // already storey-scoped via storeyNavmesh.portals itself) and the
  // unreachable-room count need filtering down to *this* storey for
  // display — the underlying load numbers still reflect the whole building,
  // only which markers get drawn on this one plan is scoped.
  const evacuationLoad = useMemo(() => {
    if (!buildingEvacuationLoad || !storeyNavmesh) return null;
    const regionIdsHere = new Set(storeyNavmesh.regions.map((r) => r.spaceId));
    const regionDistanceToExit = new Map(
      [...buildingEvacuationLoad.regionDistanceToExit].filter(([id]) => regionIdsHere.has(id)),
    );
    return {
      portalLoad: buildingEvacuationLoad.portalLoad,
      stairNodes: buildingEvacuationLoad.stairNodes.filter((n) => n.storeyId === storeyNavmesh.storeyId),
      unreachableSpaceIds: buildingEvacuationLoad.unreachableSpaceIds.filter((id) =>
        regionIdsHere.has(id),
      ),
      skippedSpaceIds: buildingEvacuationLoad.skippedSpaceIds.filter((id) => regionIdsHere.has(id)),
      regionDistanceToExit,
    };
  }, [buildingEvacuationLoad, storeyNavmesh]);

  const storeyNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of storeys) {
      map.set(
        s.global_id,
        s.name?.trim() || (s.elevation != null ? `E${s.elevation}` : s.global_id.slice(0, 8)),
      );
    }
    return map;
  }, [storeys]);

  /** Real (non-vertical-connector) portal ids only exist per-storey on `mesh.portals` — pool them across every storey so building-wide load entries can be labelled regardless of which storey is on screen. */
  const portalInfoById = useMemo(() => {
    const map = new Map<
      string,
      {
        storeyId: string;
        kind: "door" | "space" | "exit";
        doorGlobalId: string | null;
        point: Point2D;
      }
    >();
    for (const mesh of allStoreyNavmeshes) {
      for (const p of mesh.portals) {
        map.set(p.id, {
          storeyId: mesh.storeyId,
          kind: p.kind,
          doorGlobalId: p.doorGlobalId,
          point: p.point,
        });
      }
    }
    return map;
  }, [allStoreyNavmeshes]);

  type BottleneckEntry = {
    id: string;
    storeyId: string;
    storeyName: string;
    kind: "exit" | "door" | "space" | "stair" | "lift";
    label: string;
    load: number;
    point: Point2D;
  };

  // O(1) lookups for the two loops below instead of Array.find() inside
  // them — cheap at today's test-model scale (a handful of stairs) but a
  // real quadratic cost once a building has hundreds of portals crossed
  // against hundreds of stairs/graph nodes.
  const stairNodesById = useMemo(() => {
    const map = new Map<string, { id: string; storeyId: string; point: Point2D }>();
    if (buildingEvacuationLoad) {
      for (const n of buildingEvacuationLoad.stairNodes) map.set(n.id, n);
    }
    return map;
  }, [buildingEvacuationLoad]);

  const graphNodesById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    if (connectivityGraph) {
      for (const n of connectivityGraph.nodes) map.set(n.id, n);
    }
    return map;
  }, [connectivityGraph]);

  // Ranked view of the same `buildingEvacuationLoad.portalLoad` map the heat
  // colors already use — a scannable top-N list next to the color dots,
  // resolved back to a human label (door name / stair name / storey) instead
  // of raw portal ids. Carries each entry's plan point too, so clicking one
  // can fly the 3D camera there (see viewerFocusRequest), not just switch
  // the 2D storey.
  const worstBottlenecks = useMemo<BottleneckEntry[]>(() => {
    if (!buildingEvacuationLoad) return [];
    const entries: BottleneckEntry[] = [];
    for (const [id, load] of buildingEvacuationLoad.portalLoad) {
      if (id.startsWith("vlink-evac:")) {
        const rest = id.slice("vlink-evac:".length);
        const at = rest.lastIndexOf("@");
        if (at < 0) continue;
        const linkId = rest.slice(0, at);
        const storeyId = rest.slice(at + 1);
        const stair = stairNodesById.get(id);
        if (!stair) continue;
        const isLift = linkId.startsWith("lift:");
        const graphNode = graphNodesById.get(linkId);
        const fallback = `${isLift ? "Lift" : "Stair"} ${linkId.split(":")[1]?.slice(0, 8) ?? ""}`;
        entries.push({
          id,
          storeyId,
          storeyName: storeyNameById.get(storeyId) ?? storeyId,
          kind: isLift ? "lift" : "stair",
          label: graphNode?.name?.trim() || fallback,
          load,
          point: stair.point,
        });
      } else {
        const info = portalInfoById.get(id);
        if (!info) continue;
        const door = info.doorGlobalId ? doorsByGlobalId.get(info.doorGlobalId) : null;
        const fallback = info.kind === "exit" ? "Exit" : info.kind === "door" ? "Door" : "Passage";
        entries.push({
          id,
          storeyId: info.storeyId,
          storeyName: storeyNameById.get(info.storeyId) ?? info.storeyId,
          kind: info.kind,
          label: door?.name?.trim() || fallback,
          load,
          point: info.point,
        });
      }
    }
    entries.sort((a, b) => b.load - a.load);
    return entries.slice(0, 8);
  }, [buildingEvacuationLoad, stairNodesById, graphNodesById, storeyNameById, portalInfoById, doorsByGlobalId]);

  // Every loaded door/exit/stair/lift with nonzero load, in plan space —
  // the full building, not just the top 8 shown in the ranked list. Published
  // to the shared store (see EvacuationLoadMarker) so InferModelViewport can
  // lift each point into Three coordinates and render its own 3D markers,
  // the same way it already builds its own navmesh overlay from shared
  // footprints/graph state instead of receiving pre-built Three.js geometry.
  const evacuationLoadMarkersForViewer = useMemo(() => {
    if (!buildingEvacuationLoad) return null;
    const markers: EvacuationLoadMarker[] = [];
    for (const [id, load] of buildingEvacuationLoad.portalLoad) {
      if (id.startsWith("vlink-evac:")) {
        const rest = id.slice("vlink-evac:".length);
        const at = rest.lastIndexOf("@");
        if (at < 0) continue;
        const linkId = rest.slice(0, at);
        const storeyId = rest.slice(at + 1);
        const stair = stairNodesById.get(id);
        if (!stair) continue;
        markers.push({
          id,
          storeyId,
          point: stair.point,
          kind: linkId.startsWith("lift:") ? "lift" : "stair",
          load,
        });
      } else {
        const info = portalInfoById.get(id);
        if (!info) continue;
        markers.push({ id, storeyId: info.storeyId, point: info.point, kind: info.kind, load });
      }
    }
    return markers;
  }, [buildingEvacuationLoad, stairNodesById, portalInfoById]);

  useEffect(() => {
    setEvacuationLoadMarkers(evacuationLoadMarkersForViewer);
  }, [evacuationLoadMarkersForViewer, setEvacuationLoadMarkers]);

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
  // Match the drawn circle closely — *2.5 made dense door clusters steal
  // room clicks and felt larger than the marker itself.
  const portalHitR = portalR * 1.1;

  const navmeshPickRef = useRef({
    enabled: false as boolean,
    // Plain Floorplan (IFC) tab: left-click-to-select on the same underlying
    // space hit-testing as Navmesh mode. Separate flag (not folded into
    // `enabled`) because the two modes' click semantics don't overlap.
    ifcPickEnabled: false as boolean,
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
    excludedNodeIds: new Set<string>() as ReadonlySet<string>,
  });
  navmeshPickRef.current = {
    enabled: planDisplayMode === "navmesh" && storeyNavmesh != null,
    ifcPickEnabled: planDisplayMode === "ifc" && storeyNavmesh != null,
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
    excludedNodeIds,
  };

  const selectElementRef = useRef(selectElement);
  selectElementRef.current = selectElement;
  /** Single-click selects after a short delay; double-click cancels and blocks. */
  const pendingPortalSelectRef = useRef<{
    id: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const incompleteCount =
    footprintsDocument?.spaces.filter((s) => s.incomplete).length ?? 0;

  const navmeshInfoParts: string[] = [];
  if (planDisplayMode === "navmesh" && navmeshRoute && !navmeshRoute.end) {
    if (navmeshPickMode === "exit") {
      navmeshInfoParts.push("right-click a point to route to the nearest exit");
    } else {
      navmeshInfoParts.push(
        navmeshRoute.storeyId === displayStoreyId
          ? "right-click end point"
          : "right-click end point (start pin is on another floor)",
      );
    }
  }
  if (navmeshPathNote) navmeshInfoParts.push(navmeshPathNote);
  if (navmeshRoute?.end) {
    navmeshInfoParts.push(
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
    if (note) navmeshInfoParts.push(note);
  }
  const navmeshInfoMessage = navmeshInfoParts.join(" · ");
  const regionCount = storeyNavmesh?.regions.length ?? 0;
  const portalCount = storeyNavmesh?.portals.length ?? 0;

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
      // Shift+wheel rotates about the cursor; plain wheel still zooms there.
      if (e.shiftKey) {
        const pivot = clientToView(e.clientX, e.clientY, svg, bounds, cam);
        const delta = (e.deltaY > 0 ? -1 : 1) * ((5 * Math.PI) / 180);
        const pan = panDeltaForRotationAt(bounds, cam, pivot, delta);
        cameraRef.current = {
          ...cam,
          rotation: normalizeRotation(cam.rotation + delta),
          panX: cam.panX + pan.x,
          panY: cam.panY + pan.y,
        };
        applyCameraDom();
        return;
      }

      const viewBefore = clientToView(e.clientX, e.clientY, svg, bounds, cam);
      const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      const nextZoom = Math.min(Math.max(cam.zoom * factor, 0.25), 40);
      const pan = panDeltaForZoomAt(bounds, cam, viewBefore, nextZoom);
      const next = {
        ...cam,
        zoom: nextZoom,
        panX: cam.panX + pan.x,
        panY: cam.panY + pan.y,
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
          graphNodeIds: null,
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
          graphNodeIds: null,
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
        graphNodeIds: null,
      });
    };

    /**
     * Plain Floorplan tab no longer excludes on right-click — use the
     * Inspector "Remove" button (or Graph Viewer right-click) instead.
     * Navmesh tab still places route pins on short right-click.
     */
    const clearPendingPortalSelect = () => {
      const pending = pendingPortalSelectRef.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingPortalSelectRef.current = null;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0) {
        e.preventDefault();
        draggingRef.current = true;
        surface.setPointerCapture(e.pointerId);
        const bounds = boundsRef.current;
        const svg = svgRef.current;
        const rotate = e.altKey;
        const pivot =
          rotate && bounds && svg
            ? clientToView(e.clientX, e.clientY, svg, bounds, cameraRef.current)
            : null;
        dragRef.current = {
          pointerId: e.pointerId,
          lastX: e.clientX,
          lastY: e.clientY,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          mode: rotate ? "rotate" : "pan",
          pivot,
          lastAngle: null,
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

      if (drag.mode === "rotate" && drag.pivot) {
        // Orbit about the gesture-start screen point. SVG Y grows down, so
        // atan2 uses −dy to match the Y-up flip group where rotation lives.
        const sx = e.clientX - drag.startX;
        const sy = e.clientY - drag.startY;
        if (sx * sx + sy * sy < 64) return; // too close to centre — angle unstable
        const angle = Math.atan2(-sy, sx);
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        if (drag.lastAngle == null) {
          drag.lastAngle = angle;
          return;
        }
        let delta = angle - drag.lastAngle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        drag.lastAngle = angle;
        if (!Number.isFinite(delta) || delta === 0) return;
        const cam = cameraRef.current;
        const pan = panDeltaForRotationAt(bounds, cam, drag.pivot, delta);
        cameraRef.current = {
          ...cam,
          rotation: normalizeRotation(cam.rotation + delta),
          panX: cam.panX + pan.x,
          panY: cam.panY + pan.y,
        };
        applyCameraDom();
        return;
      }

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
        // Short right-click → place navmesh pin (Navmesh tab only).
        // Soft-exclude moved to the Inspector Remove button / Graph Viewer.
        if (!longFired && !moved && !navmeshPickRef.current.ifcPickEnabled) {
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

      // Left-click (not pan): portal → delayed select / double-click blocks;
      // otherwise a region toggles graph/floorplan selection.
      if (!drag || drag.moved) return;
      const pick = navmeshPickRef.current;
      if (pick.enabled && pick.mesh) {
        const bounds = boundsRef.current;
        const svg = svgRef.current;
        if (!bounds || !svg) return;
        const world = clientToView(e.clientX, e.clientY, svg, bounds, cameraRef.current);
        const portal = nearestPortalWithin(pick.mesh.portals, world, pick.portalHitR);
        if (portal) {
          const pending = pendingPortalSelectRef.current;
          if (pending && pending.id === portal.id) {
            // Second click of a double-click — block only, never select.
            clearPendingPortalSelect();
            setBlockedPortalIds((prev) => {
              const next = new Set(prev);
              if (next.has(portal.id)) next.delete(portal.id);
              else next.add(portal.id);
              return next;
            });
            return;
          }
          clearPendingPortalSelect();
          const timer = setTimeout(() => {
            pendingPortalSelectRef.current = null;
            selectElementRef.current(`portal:${portal.id}`);
          }, 280);
          pendingPortalSelectRef.current = { id: portal.id, timer };
          return;
        }
        clearPendingPortalSelect();
        const region = regionAtPoint(pick.mesh, world);
        if (!region) return;
        selectElementRef.current(region.spaceId);
        return;
      }
      clearPendingPortalSelect();
      // Plain Floorplan tab: click a room to select it. Skips excluded
      // parents so nested children become hittable after Remove — same
      // idea as navmesh (excluded parent leaves the region set).
      if (pick.ifcPickEnabled) {
        const bounds = boundsRef.current;
        const svg = svgRef.current;
        if (!bounds || !svg) return;
        const world = clientToView(e.clientX, e.clientY, svg, bounds, cameraRef.current);
        const space = spaceAtWorldPoint(
          world,
          pick.footprints,
          pick.storeyId,
          pick.excludedNodeIds,
        );
        if (!space) return;
        selectElementRef.current(`space:${space.global_id}`);
      }
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
      clearPendingPortalSelect();
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
            <div className={cn(GLASS, "flex overflow-hidden")} role="tablist" aria-label="Plan display mode">
              <button
                type="button"
                role="tab"
                aria-selected={planDisplayMode === "ifc"}
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
                role="tab"
                aria-selected={planDisplayMode === "navmesh"}
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
              <>
              <div className={cn(GLASS, "flex overflow-hidden")} role="tablist" aria-label="Navmesh pick mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={navmeshPickMode === "route"}
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
                  role="tab"
                  aria-selected={navmeshPickMode === "exit"}
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
              <button
                type="button"
                aria-pressed={showEvacuationLoad}
                onClick={() => setShowEvacuationLoad(!showEvacuationLoad)}
                className={cn(
                  GLASS,
                  "pointer-events-auto inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] transition-colors",
                  showEvacuationLoad
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                title="Simulate every room's route to its nearest exit and heat-map which doors carry the most traffic"
              >
                <Flame
                  className={cn("size-3.5", isEvacuationLoadPending && "animate-pulse")}
                  aria-hidden
                />
                Evacuation load
                {isEvacuationLoadPending ? (
                  <span className="text-[10px] font-normal text-muted-foreground">
                    computing…
                  </span>
                ) : null}
              </button>
              </>
            ) : null}
            {navmeshBusy ? (
              <span className="text-[10px] text-muted-foreground">
                Recalculating navmesh…
              </span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={resetCamera}
            disabled={!buildingBounds}
            className={cn(
              GLASS,
              "pointer-events-auto inline-flex h-8 items-center gap-1 px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40",
            )}
            title="Fit all floors and reset rotation (shared frame)"
          >
            <Maximize2 className="size-3" aria-hidden />
            Fit
          </button>
        </div>

        {!footprintsDocument ? (
          <div className="grid h-full place-items-center px-4 text-center">
            <div className="flex flex-col items-center gap-3">
              <p className="text-xs text-muted-foreground">
                Open a model to build space polygons for the plan.
              </p>
              <Button size="sm" onClick={() => setIngestOpen(true)}>
                <FolderOpen aria-hidden />
                Open model
              </Button>
            </div>
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
                    furniture={furniture}
                    spaces={spaces}
                    excludedNodeIds={excludedNodeIds}
                    stairs={stairs}
                    doors={doors}
                    storeyNavmesh={storeyNavmesh}
                    pathPoints={pathPoints}
                    navmeshStart={navmeshStart}
                    navmeshEnd={navmeshEnd}
                    isExitRoute={isExitRoute}
                    blockedPortalIds={blockedPortalIds}
                    evacuationLoad={evacuationLoad ?? null}
                    doorsByGlobalId={doorsByGlobalId}
                    palette={palette}
                    selectedSpaces={selectedSpaces}
                    selectedPortalIds={selectedPortalIds}
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
                      <g className="infer-screen-fixed-scale" data-world-orient="1" transform="scale(1)">
                        {/* Facing cone first (under the disc), Google Maps style.
                            data-world-orient: counter-scale only — heading stays
                            aligned with the rotated plan, not the screen. */}
                        <path
                          d={headingConePath(
                            0,
                            0,
                            cameraDot.heading,
                            cameraR * 4.2,
                            (58 * Math.PI) / 180,
                          )}
                          fill="color-mix(in oklch, var(--primary) 38%, transparent)"
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
                          fill="var(--primary)"
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
                          stroke="var(--destructive)"
                          strokeWidth={doorStroke * 0.7}
                          opacity={0.85}
                        />
                        <path
                          d={`M${-portalR * 0.9} ${-portalR * 0.9} L${portalR * 0.9} ${portalR * 0.9} M${-portalR * 0.9} ${portalR * 0.9} L${portalR * 0.9} ${-portalR * 0.9}`}
                          stroke="var(--destructive)"
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
              aria-label="Floorplan pan, zoom, and rotate surface"
              title={
                planDisplayMode === "navmesh"
                  ? "Left-drag: pan. Shift+scroll: rotate. Scroll: zoom. Left-click region: select. Left-click portal: select · double-click: block. Right-click: set start then end. Long right-click: clear."
                  : "Left-drag: pan. Shift+scroll: rotate. Scroll: zoom. Left-click room: select. Remove spaces from the selection popup."
              }
            />

            {spaces.length === 0 && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center px-4 text-center text-xs text-muted-foreground">
                No complete footprints on this storey
                {incompleteCount > 0 ? ` (${incompleteCount} incomplete in model)` : ""}.
                IFC spaces need placement or mesh geometry.
              </div>
            )}

            <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/80 bg-background/90 px-2 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="pointer-events-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground transition-colors hover:bg-muted"
                  >
                    <Layers className="size-3" aria-hidden />
                    Legend
                    <ChevronDown className="size-3 text-muted-foreground" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-60 text-[12px]">
                  {planDisplayMode === "navmesh" ? (
                    <>
                      <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                        Legend
                      </DropdownMenuLabel>
                      <div className="flex flex-col gap-1.5 px-2 pb-2">
                        <div className="flex items-center gap-1.5 text-foreground">
                          <span
                            className="inline-block size-2.5 shrink-0 border border-[#64748b]"
                            style={{ background: "rgba(148,163,184,0.35)" }}
                          />
                          Region
                        </div>
                        {showEvacuationLoad ? (
                          <>
                            <div className="flex items-center gap-1.5 text-foreground">
                              <span
                                className="inline-block size-2 shrink-0 rounded-full"
                                style={{ background: evacuationHeatColor(0.1) }}
                              />
                              Low evacuation load
                            </div>
                            <div className="flex items-center gap-1.5 text-foreground">
                              <span
                                className="inline-block size-3 shrink-0 rounded-full"
                                style={{ background: evacuationHeatColor(1) }}
                              />
                              High evacuation load
                            </div>
                            {evacuationLoad && evacuationLoad.stairNodes.length > 0 ? (
                              <div className="flex items-center gap-1.5 text-foreground">
                                <span
                                  className="inline-block size-2.5 shrink-0"
                                  style={{ background: "var(--stair-glyph)" }}
                                />
                                Stair/lift landing (square)
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-1.5 text-foreground">
                              <span
                                className="inline-block size-2 shrink-0 rounded-full"
                                style={{ background: PORTAL_COLORS.door }}
                              />
                              IFC door
                            </div>
                            <div className="flex items-center gap-1.5 text-foreground">
                              <span
                                className="inline-block size-2 shrink-0 rounded-full"
                                style={{ background: PORTAL_COLORS.doorHeal }}
                              />
                              Door heal
                            </div>
                            <div className="flex items-center gap-1.5 text-foreground">
                              <span
                                className="inline-block size-2 shrink-0 rounded-full"
                                style={{ background: PORTAL_COLORS.spacePortal }}
                              />
                              Space heal
                            </div>
                            <div className="flex items-center gap-1.5 text-foreground">
                              <span
                                className="inline-block size-2 shrink-0 rounded-full"
                                style={{ background: PORTAL_COLORS.exit }}
                              />
                              Exit
                            </div>
                          </>
                        )}
                      </div>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                    Layers
                  </DropdownMenuLabel>
                  {(
                    planDisplayMode === "ifc"
                      ? ([
                          {
                            key: "route" as const,
                            label: "Route",
                            swatch: <span className="inline-block h-0.5 w-4 bg-route-normal" />,
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
                              <span className="inline-block h-1.5 w-3 rounded-[1px] bg-door-glyph" />
                            ),
                          },
                          {
                            key: "stairs" as const,
                            label: "Stair",
                            swatch: (
                              <span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-stair-glyph" />
                            ),
                          },
                          {
                            key: "furniture" as const,
                            label: "Furniture",
                            swatch: (
                              <span className="inline-block size-2.5 border bg-furniture-fill border-furniture-stroke" />
                            ),
                          },
                        ] as const)
                      : ([
                          {
                            key: "route" as const,
                            label: "Route",
                            swatch: <span className="inline-block h-0.5 w-4 bg-route-normal" />,
                          },
                          {
                            key: "furniture" as const,
                            label: "Furniture",
                            swatch: (
                              <span className="inline-block size-2.5 border bg-furniture-fill border-furniture-stroke" />
                            ),
                          },
                        ] as const)
                  ).map((item) => (
                    <DropdownMenuCheckboxItem
                      key={item.key}
                      checked={layers[item.key]}
                      onCheckedChange={() => toggleLayer(item.key)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      <span className="mr-1.5 inline-flex items-center">{item.swatch}</span>
                      {item.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {planDisplayMode === "navmesh" && storeyNavmesh ? (
                <>
                  <span>
                    <span className="font-medium text-foreground">{regionCount}</span> regions
                  </span>
                  <span>
                    <span className="font-medium text-foreground">{portalCount}</span> portals
                  </span>
                </>
              ) : null}

              <span
                className={cn(
                  "inline-flex items-center gap-1",
                  cameraDot ? "text-foreground" : "text-muted-foreground/50",
                )}
                title={cameraDotInfo.reason}
              >
                <span className="inline-block size-2 rounded-full bg-primary" />
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
                  <span className="inline-block size-2 rounded-full bg-portal-blocked" />
                  {blockedPortalIds.size} blocked · clear
                </button>
              ) : null}
              {planDisplayMode === "navmesh" &&
              evacuationLoad &&
              evacuationLoad.unreachableSpaceIds.length > 0 ? (
                <span className="inline-flex items-center gap-1 text-destructive">
                  {evacuationLoad.unreachableSpaceIds.length} room
                  {evacuationLoad.unreachableSpaceIds.length === 1 ? "" : "s"} with no reachable exit
                </span>
              ) : null}

              {navmeshInfoMessage ? (
                <span className="min-w-0 truncate text-foreground" title={navmeshInfoMessage}>
                  {navmeshInfoMessage}
                </span>
              ) : null}
            </div>

            {showEvacuationLoad && worstBottlenecks.length > 0 ? (
              <div
                className={cn(
                  GLASS,
                  "pointer-events-auto absolute right-2 top-2 z-20 w-56 overflow-hidden text-[11px]",
                )}
              >
                <div
                  className="flex items-center gap-1.5 border-b border-border/80 px-2.5 py-1.5 font-medium text-foreground"
                  title="Estimated occupants whose shortest route to an exit passes through each door or stair — area-weighted (assumes ~10 m² per occupant), not a formal fire-egress calculation"
                >
                  <Flame className="size-3 text-muted-foreground" aria-hidden />
                  Worst bottlenecks
                  <span className="ml-auto text-[10px] font-normal text-muted-foreground">est. occ.</span>
                </div>
                <ol className="max-h-64 overflow-y-auto py-1">
                  {worstBottlenecks.map((entry, i) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveStoreyId(entry.storeyId);
                          // Fly the 3D camera there too — the whole point of
                          // a ranked list is to jump straight to the worst
                          // spot, not just switch which 2D plan is showing.
                          setViewerFocusRequest({ point: entry.point, storeyId: entry.storeyId });
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 px-2.5 py-1 text-left transition-colors hover:bg-muted",
                          entry.storeyId === displayStoreyId ? "bg-muted/50" : "",
                        )}
                        title={`${entry.label} — ${entry.storeyName} — ~${Math.round(entry.load)} occupants estimated`}
                      >
                        <span className="w-3.5 shrink-0 text-right text-muted-foreground">{i + 1}</span>
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{
                            background: evacuationHeatColor(
                              worstBottlenecks[0] ? entry.load / worstBottlenecks[0].load : 0,
                            ),
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">{entry.label}</span>
                        <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                          {entry.storeyName}
                        </span>
                        <span className="shrink-0 tabular-nums font-medium text-foreground">
                          {Math.round(entry.load)} occ.
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
