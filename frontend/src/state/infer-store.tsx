import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ConnectivityGraph, RouteResult } from "@/types/graph";
import type { EntitiesExtract } from "@/api/models";
import type { FootprintsDocument, Point2D } from "@/types/footprints";
import type { ViewerCameraPose, ThreeAabb, Mat4Elements } from "@/lib/viewer-camera-pose";
import type { ExportableGeometrySource } from "@/lib/live-scene-export";

/** Pulls the live 3D pane's currently loaded geometry for a faithful export; see ThatOpenRuntime.getExportableObjects. */
type ViewerExportFn = () => ExportableGeometrySource | null;

/**
 * Floorplan click-to-click route (pins + A* polyline). Survives IFC/navmesh
 * mode toggles and storey switches — the end pin may land on a different
 * storey than the start, producing a cross-storey path via stairs/lifts.
 */
export type NavmeshRoute = {
  /** Storey the start pin was placed on. */
  storeyId: string;
  start: Point2D;
  end: Point2D | null;
  /** Storey the end pin was placed on; differs from `storeyId` for a cross-storey route. */
  endStoreyId: string | null;
  /** Set when both pins are on the same storey and A* succeeded. */
  points: Point2D[] | null;
  /** Set when the pins are on different storeys and a path was found — one entry per storey it crosses. */
  segments: { storeyId: string; points: Point2D[] }[] | null;
  /**
   * Ordered graph node ids (`space:` / `stair:` / `lift:`) for the hops this
   * route crosses — Graph Viewer highlights them with the route ring.
   * Null when no path (or only a start pin).
   */
  graphNodeIds: string[] | null;
};

/**
 * One door/exit/stair/lift's evacuation-load result, in plan space —
 * FloorplanViewer computes the full building-wide load (it already owns the
 * "what-if block this door" state the calculation depends on) and publishes
 * this flattened, storey-tagged list so InferModelViewport can lift each
 * point into Three coordinates and render its own 3D markers, the same way
 * the two panes already each build their own navmesh overlay from shared
 * footprints/graph state rather than one pane pushing the other's computed
 * Three.js geometry.
 */
export type EvacuationLoadMarker = {
  id: string;
  storeyId: string;
  point: Point2D;
  kind: "door" | "exit" | "space" | "stair" | "lift";
  load: number;
};

/**
 * The store is split into several contexts by how often each group changes
 * and who actually reads it, instead of one big InferState — bundling
 * everything meant e.g. a selection-driven update re-rendering every part of
 * the app. Heavy render consumers (FloorplanViewer, GraphViewer,
 * InferModelViewport, the workspace route) call the specific hook(s) they
 * need; everything else keeps using the combined useInfer() below.
 *
 * ViewerPoseState (viewerCameraPose etc.) was already split out earlier for
 * the same reason — it publishes at up to 20Hz during Fly navigation.
 */
interface ViewportState {
  activeStoreyId: string | "all";
  setActiveStoreyId: (id: string | "all") => void;

  /** Evacuation-load heat map toggle — shared so the 3D pane's markers (see EvacuationLoadMarker) turn on with the same control as the floorplan's. */
  showEvacuationLoad: boolean;
  setShowEvacuationLoad: (v: boolean) => void;

  selectedElementIds: string[];
  selectElement: (id: string | null) => void;
  /** Raw setter — used by ModelDataState to drop a selection when its node is excluded. */
  setSelectedElementIds: (ids: string[] | ((prev: string[]) => string[])) => void;

  /**
   * The one selected item the Control tray is expanded on (or hovering) —
   * drawn with a heavier highlight than the rest of the selection on the
   * plan and graph. Always either null or a member of selectedElementIds.
   */
  focusedElementId: string | null;
  setFocusedElementId: (id: string | null) => void;

  /** Control tray expanded (docked right); collapsed leaves a thin strip. */
  controlPanelOpen: boolean;
  setControlPanelOpen: (open: boolean) => void;

  ingestOpen: boolean;
  setIngestOpen: (v: boolean) => void;

  // That Open viewer bridge (IFC bytes queued by IngestDialog)
  pendingIfc: { name: string; buffer: Uint8Array } | null;
  queueIfcFile: (file: File) => Promise<void>;
  clearPendingIfc: () => void;
  viewerStatus: string;
  setViewerStatus: (message: string, kind?: "info" | "error" | "loading") => void;
  viewerStatusKind: "info" | "error" | "loading";
}

interface ModelDataState {
  // Backend model + connectivity graph (null graph ⇒ demo fallback in viewer)
  backendModelId: string | null;
  /** Which parser produced this model — determines the 3D pane's render path
   * (That Open/web-ifc for "ifc", a plain-footprint Three.js scene for
   * "indoorgml", which has no BIM geometry web-ifc could load). */
  sourceFormat: "ifc" | "indoorgml";
  connectivityGraph: ConnectivityGraph | null;
  entitiesExtract: EntitiesExtract | null;
  footprintsDocument: FootprintsDocument | null;
  connectivityRoute: RouteResult | null;
  setConnectivityRoute: (route: RouteResult | null) => void;
  /** Click-to-click navmesh path (floorplan + 3D tube). */
  navmeshRoute: NavmeshRoute | null;
  setNavmeshRoute: (route: NavmeshRoute | null) => void;
  /** Building-wide evacuation load, in plan space — null when the heat map is off or nothing's loaded. See EvacuationLoadMarker. */
  evacuationLoadMarkers: EvacuationLoadMarker[] | null;
  setEvacuationLoadMarkers: (markers: EvacuationLoadMarker[] | null) => void;
  /**
   * One-shot "fly the 3D camera here" command — set by the floorplan pane's
   * ranked bottleneck list on click, consumed by InferModelViewport (lifts
   * the point into Three coordinates and calls the runtime's flyToCamera),
   * then reset back to null so an identical repeat click still fires.
   */
  viewerFocusRequest: { point: Point2D; storeyId: string } | null;
  setViewerFocusRequest: (request: { point: Point2D; storeyId: string } | null) => void;
  /** Swap graph variant (IFC / geometry / topologic) without clearing entities/footprints. */
  setConnectivityGraphOnly: (graph: ConnectivityGraph) => void;
  /** Graph node ids temporarily removed from the live network (right-click toggle). */
  excludedNodeIds: ReadonlySet<string>;
  toggleExcludedNode: (nodeId: string) => void;
  clearExcludedNodes: () => void;
  /** Soft-removed edges (right-click): shown dashed, blocked for routing. */
  excludedEdgeIds: ReadonlySet<string>;
  toggleExcludedEdge: (edgeId: string) => void;
  clearExcludedEdges: () => void;
  graphSource: "model" | "none";
  setModelGraph: (payload: {
    modelId: string;
    graph: ConnectivityGraph;
    entities: EntitiesExtract;
    footprints?: FootprintsDocument | null;
    sourceFormat?: "ifc" | "indoorgml";
  }) => void;
  clearModelGraph: () => void;
}

/** Combined shape returned by useInfer() — every field from every context. */
type InferState = ViewportState & ModelDataState;

/**
 * Split out of InferState: viewerCameraPose publishes at up to 20Hz during
 * Fly navigation (see that-open-runtime.ts). Bundled into the main context
 * value, every tick re-rendered every useInfer() consumer in the app —
 * GraphViewer, panels, TopBar, everything — whether or not they read pose at
 * all. Only FloorplanViewer (the camera dot) and InferModelViewport (the
 * runtime bridge that publishes it) actually need this.
 */
interface ViewerPoseState {
  /** Live 3D camera in plan metres + elevation; null when unknown / cleared. */
  viewerCameraPose: ViewerCameraPose | null;
  setViewerCameraPose: (pose: ViewerCameraPose | null) => void;
  /** Loaded 3D model AABB (Three Y-up); used to lock plan-dot axis frame. */
  viewerModelBounds: ThreeAabb | null;
  setViewerModelBounds: (bounds: ThreeAabb | null) => void;
  /**
   * Inverse of Fragments/web-ifc coordination matrix (column-major 16).
   * Undoes COORDINATE_TO_ORIGIN so the plan-dot matches footprint IFC XY.
   */
  viewerCoordInverse: Mat4Elements | null;
  setViewerCoordInverse: (m: Mat4Elements | null) => void;
  /**
   * Bridge into the live 3D pane's ThatOpenRuntime for a faithful Share
   * export — a ref, not state: InferModelViewport writes it on load/unload,
   * and a Three.js Object3D graph isn't something React should re-render
   * over. `.current` is null whenever no IFC model has live geometry (not
   * loaded yet, or the 3D pane isn't mounted at all — e.g. an IndoorGML
   * model, or the pane closed).
   */
  viewerExportRef: { current: ViewerExportFn | null };
}

const ViewerPoseCtx = createContext<ViewerPoseState | null>(null);

function ViewerPoseProvider({ children }: { children: ReactNode }) {
  const [viewerCameraPose, setViewerCameraPose] = useState<ViewerCameraPose | null>(null);
  const [viewerModelBounds, setViewerModelBounds] = useState<ThreeAabb | null>(null);
  const [viewerCoordInverse, setViewerCoordInverse] = useState<Mat4Elements | null>(null);
  const viewerExportRef = useRef<ViewerExportFn | null>(null);

  const value = useMemo<ViewerPoseState>(
    () => ({
      viewerCameraPose,
      setViewerCameraPose,
      viewerModelBounds,
      setViewerModelBounds,
      viewerCoordInverse,
      setViewerCoordInverse,
      viewerExportRef,
    }),
    [viewerCameraPose, viewerModelBounds, viewerCoordInverse, viewerExportRef],
  );

  return <ViewerPoseCtx.Provider value={value}>{children}</ViewerPoseCtx.Provider>;
}

export function useViewerPose(): ViewerPoseState {
  const ctx = useContext(ViewerPoseCtx);
  if (!ctx) throw new Error("useViewerPose must be used inside InferProvider");
  return ctx;
}

const ViewportCtx = createContext<ViewportState | null>(null);

function ViewportProvider({ children }: { children: ReactNode }) {
  const [activeStoreyId, setActiveStoreyId] = useState<string | "all">("all");
  const [showEvacuationLoad, setShowEvacuationLoad] = useState(false);
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  const [focusedElementId, setFocusedElementId] = useState<string | null>(null);
  const [controlPanelOpen, setControlPanelOpen] = useState(true);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [pendingIfc, setPendingIfc] = useState<{ name: string; buffer: Uint8Array } | null>(
    null,
  );
  const [viewerStatus, setViewerStatusMessage] = useState("");
  const [viewerStatusKind, setViewerStatusKind] = useState<"info" | "error" | "loading">(
    "info",
  );

  const selectElement = useCallback((id: string | null) => {
    if (!id) {
      setSelectedElementIds([]);
      setFocusedElementId(null);
      return;
    }
    setSelectedElementIds((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((x) => x !== id);
        setFocusedElementId((f) => (f === id ? null : f));
        return next;
      }
      setFocusedElementId(id);
      return [...prev, id];
    });
  }, []);

  const queueIfcFile = useCallback(async (file: File) => {
    const buffer = new Uint8Array(await file.arrayBuffer());
    // Owned copy — web-ifc may detach the underlying ArrayBuffer during convert.
    setPendingIfc({ name: file.name, buffer: buffer.slice() });
  }, []);

  const clearPendingIfc = useCallback(() => setPendingIfc(null), []);

  const setViewerStatus = useCallback(
    (message: string, kind: "info" | "error" | "loading" = "info") => {
      setViewerStatusMessage(message);
      setViewerStatusKind(kind);
    },
    [],
  );

  const value = useMemo<ViewportState>(
    () => ({
      activeStoreyId,
      setActiveStoreyId,
      showEvacuationLoad,
      setShowEvacuationLoad,
      selectedElementIds,
      selectElement,
      setSelectedElementIds,
      focusedElementId,
      setFocusedElementId,
      controlPanelOpen,
      setControlPanelOpen,
      ingestOpen,
      setIngestOpen,
      pendingIfc,
      queueIfcFile,
      clearPendingIfc,
      viewerStatus,
      setViewerStatus,
      viewerStatusKind,
    }),
    [
      activeStoreyId,
      showEvacuationLoad,
      selectedElementIds,
      selectElement,
      focusedElementId,
      controlPanelOpen,
      ingestOpen,
      pendingIfc,
      queueIfcFile,
      clearPendingIfc,
      viewerStatus,
      setViewerStatus,
      viewerStatusKind,
    ],
  );

  return <ViewportCtx.Provider value={value}>{children}</ViewportCtx.Provider>;
}

export function useViewport(): ViewportState {
  const ctx = useContext(ViewportCtx);
  if (!ctx) throw new Error("useViewport must be used inside InferProvider");
  return ctx;
}

const ModelDataCtx = createContext<ModelDataState | null>(null);

function ModelDataProvider({ children }: { children: ReactNode }) {
  const { setActiveStoreyId, setSelectedElementIds, setFocusedElementId } = useViewport();
  const { setViewerCameraPose, setViewerModelBounds, setViewerCoordInverse } = useViewerPose();

  const [backendModelId, setBackendModelId] = useState<string | null>(null);
  const [sourceFormat, setSourceFormat] = useState<"ifc" | "indoorgml">("ifc");
  const [connectivityGraph, setConnectivityGraph] = useState<ConnectivityGraph | null>(null);
  const [entitiesExtract, setEntitiesExtract] = useState<EntitiesExtract | null>(null);
  const [footprintsDocument, setFootprintsDocument] = useState<FootprintsDocument | null>(null);
  const [connectivityRoute, setConnectivityRoute] = useState<RouteResult | null>(null);
  const [navmeshRoute, setNavmeshRoute] = useState<NavmeshRoute | null>(null);
  const [evacuationLoadMarkers, setEvacuationLoadMarkers] = useState<
    EvacuationLoadMarker[] | null
  >(null);
  const [viewerFocusRequest, setViewerFocusRequest] = useState<{
    point: Point2D;
    storeyId: string;
  } | null>(null);
  const [excludedNodeIds, setExcludedNodeIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [excludedEdgeIds, setExcludedEdgeIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const toggleExcludedNode = useCallback(
    (nodeId: string) => {
      const willExclude = !excludedNodeIds.has(nodeId);
      setExcludedNodeIds((prev) => {
        const next = new Set(prev);
        if (willExclude) next.add(nodeId);
        else next.delete(nodeId);
        return next;
      });
      if (willExclude) {
        setSelectedElementIds((sel) => sel.filter((id) => id !== nodeId));
        setFocusedElementId((f) => (f === nodeId ? null : f));
      }
    },
    [excludedNodeIds, setSelectedElementIds, setFocusedElementId],
  );

  const clearExcludedNodes = useCallback(() => {
    setExcludedNodeIds(new Set());
  }, []);

  const toggleExcludedEdge = useCallback(
    (edgeId: string) => {
      const willExclude = !excludedEdgeIds.has(edgeId);
      setExcludedEdgeIds((prev) => {
        const next = new Set(prev);
        if (willExclude) next.add(edgeId);
        else next.delete(edgeId);
        return next;
      });
      if (willExclude) {
        const portalSel = `portal:${edgeId}`;
        setSelectedElementIds((sel) => sel.filter((id) => id !== portalSel));
        setFocusedElementId((f) => (f === portalSel ? null : f));
      }
    },
    [excludedEdgeIds, setSelectedElementIds, setFocusedElementId],
  );

  const clearExcludedEdges = useCallback(() => {
    setExcludedEdgeIds(new Set());
  }, []);

  const setModelGraph = useCallback(
    (payload: {
      modelId: string;
      graph: ConnectivityGraph;
      entities: EntitiesExtract;
      footprints?: FootprintsDocument | null;
      sourceFormat?: "ifc" | "indoorgml";
    }) => {
      setBackendModelId(payload.modelId);
      setSourceFormat(payload.sourceFormat ?? "ifc");
      setConnectivityGraph(payload.graph);
      setEntitiesExtract(payload.entities);
      setFootprintsDocument(payload.footprints ?? null);
      setConnectivityRoute(null);
      setNavmeshRoute(null);
      setEvacuationLoadMarkers(null);
      setViewerFocusRequest(null);
      setExcludedNodeIds(new Set());
      setExcludedEdgeIds(new Set());
      const firstStorey =
        payload.footprints?.storeys[0]?.global_id ?? payload.entities.storeys[0]?.global_id;
      if (firstStorey) setActiveStoreyId(firstStorey);
    },
    [setActiveStoreyId],
  );

  const clearModelGraph = useCallback(() => {
    setBackendModelId(null);
    setSourceFormat("ifc");
    setConnectivityGraph(null);
    setEntitiesExtract(null);
    setFootprintsDocument(null);
    setConnectivityRoute(null);
    setNavmeshRoute(null);
    setEvacuationLoadMarkers(null);
    setViewerFocusRequest(null);
    setExcludedNodeIds(new Set());
    setExcludedEdgeIds(new Set());
    setViewerCameraPose(null);
    setViewerModelBounds(null);
    setViewerCoordInverse(null);
  }, [setViewerCameraPose, setViewerModelBounds, setViewerCoordInverse]);

  const setConnectivityGraphOnly = useCallback((graph: ConnectivityGraph) => {
    setConnectivityGraph(graph);
    setConnectivityRoute(null);
  }, []);

  const value = useMemo<ModelDataState>(
    () => ({
      backendModelId,
      sourceFormat,
      connectivityGraph,
      entitiesExtract,
      footprintsDocument,
      connectivityRoute,
      setConnectivityRoute,
      navmeshRoute,
      setNavmeshRoute,
      evacuationLoadMarkers,
      setEvacuationLoadMarkers,
      viewerFocusRequest,
      setViewerFocusRequest,
      setConnectivityGraphOnly,
      excludedNodeIds,
      toggleExcludedNode,
      clearExcludedNodes,
      excludedEdgeIds,
      toggleExcludedEdge,
      clearExcludedEdges,
      graphSource: connectivityGraph ? "model" : "none",
      setModelGraph,
      clearModelGraph,
    }),
    [
      backendModelId,
      sourceFormat,
      connectivityGraph,
      entitiesExtract,
      footprintsDocument,
      connectivityRoute,
      navmeshRoute,
      evacuationLoadMarkers,
      viewerFocusRequest,
      setConnectivityGraphOnly,
      excludedNodeIds,
      toggleExcludedNode,
      clearExcludedNodes,
      excludedEdgeIds,
      toggleExcludedEdge,
      clearExcludedEdges,
      setModelGraph,
      clearModelGraph,
    ],
  );

  return <ModelDataCtx.Provider value={value}>{children}</ModelDataCtx.Provider>;
}

export function useModelData(): ModelDataState {
  const ctx = useContext(ModelDataCtx);
  if (!ctx) throw new Error("useModelData must be used inside InferProvider");
  return ctx;
}

export function InferProvider({ children }: { children: ReactNode }) {
  return (
    <ViewerPoseProvider>
      <ViewportProvider>
        <ModelDataProvider>{children}</ModelDataProvider>
      </ViewportProvider>
    </ViewerPoseProvider>
  );
}

/**
 * Combined view of every context below ViewerPoseState — kept for the many
 * lightweight consumers (panels, toolbars, the ingest dialog) where
 * subscribing to everything costs nothing. Render-heavy consumers
 * (FloorplanViewer, GraphViewer, InferModelViewport, the workspace route)
 * call useViewport()/useModelData() directly instead, so a change in one
 * doesn't re-render a component that only reads another.
 */
export function useInfer(): InferState {
  const viewport = useViewport();
  const modelData = useModelData();
  return useMemo(() => ({ ...viewport, ...modelData }), [viewport, modelData]);
}
