import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ConnectivityGraph, RouteResult } from "@/types/graph";
import type { EntitiesExtract } from "@/api/models";
import type { FootprintsDocument, Point2D } from "@/types/footprints";
import type { ViewerCameraPose, ThreeAabb, Mat4Elements } from "@/lib/viewer-camera-pose";

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

  selectedElementIds: string[];
  selectElement: (id: string | null) => void;
  /** Raw setter — used by ModelDataState to drop a selection when its node is excluded. */
  setSelectedElementIds: (ids: string[] | ((prev: string[]) => string[])) => void;

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
  connectivityGraph: ConnectivityGraph | null;
  entitiesExtract: EntitiesExtract | null;
  footprintsDocument: FootprintsDocument | null;
  connectivityRoute: RouteResult | null;
  setConnectivityRoute: (route: RouteResult | null) => void;
  /** Click-to-click navmesh path (floorplan + 3D tube). */
  navmeshRoute: NavmeshRoute | null;
  setNavmeshRoute: (route: NavmeshRoute | null) => void;
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
}

const ViewerPoseCtx = createContext<ViewerPoseState | null>(null);

function ViewerPoseProvider({ children }: { children: ReactNode }) {
  const [viewerCameraPose, setViewerCameraPose] = useState<ViewerCameraPose | null>(null);
  const [viewerModelBounds, setViewerModelBounds] = useState<ThreeAabb | null>(null);
  const [viewerCoordInverse, setViewerCoordInverse] = useState<Mat4Elements | null>(null);

  const value = useMemo<ViewerPoseState>(
    () => ({
      viewerCameraPose,
      setViewerCameraPose,
      viewerModelBounds,
      setViewerModelBounds,
      viewerCoordInverse,
      setViewerCoordInverse,
    }),
    [viewerCameraPose, viewerModelBounds, viewerCoordInverse],
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
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
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
      return;
    }
    setSelectedElementIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
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
      selectedElementIds,
      selectElement,
      setSelectedElementIds,
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
      selectedElementIds,
      selectElement,
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
  const { setActiveStoreyId, setSelectedElementIds } = useViewport();
  const { setViewerCameraPose, setViewerModelBounds, setViewerCoordInverse } = useViewerPose();

  const [backendModelId, setBackendModelId] = useState<string | null>(null);
  const [connectivityGraph, setConnectivityGraph] = useState<ConnectivityGraph | null>(null);
  const [entitiesExtract, setEntitiesExtract] = useState<EntitiesExtract | null>(null);
  const [footprintsDocument, setFootprintsDocument] = useState<FootprintsDocument | null>(null);
  const [connectivityRoute, setConnectivityRoute] = useState<RouteResult | null>(null);
  const [navmeshRoute, setNavmeshRoute] = useState<NavmeshRoute | null>(null);
  const [excludedNodeIds, setExcludedNodeIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [excludedEdgeIds, setExcludedEdgeIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const toggleExcludedNode = useCallback(
    (nodeId: string) => {
      setExcludedNodeIds((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      });
      // Drop floorplan/graph highlight when the node is removed (or restored).
      setSelectedElementIds((prev) =>
        prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : prev,
      );
    },
    [setSelectedElementIds],
  );

  const clearExcludedNodes = useCallback(() => {
    setExcludedNodeIds(new Set());
  }, []);

  const toggleExcludedEdge = useCallback((edgeId: string) => {
    setExcludedEdgeIds((prev) => {
      const next = new Set(prev);
      if (next.has(edgeId)) next.delete(edgeId);
      else next.add(edgeId);
      return next;
    });
  }, []);

  const clearExcludedEdges = useCallback(() => {
    setExcludedEdgeIds(new Set());
  }, []);

  const setModelGraph = useCallback(
    (payload: {
      modelId: string;
      graph: ConnectivityGraph;
      entities: EntitiesExtract;
      footprints?: FootprintsDocument | null;
    }) => {
      setBackendModelId(payload.modelId);
      setConnectivityGraph(payload.graph);
      setEntitiesExtract(payload.entities);
      setFootprintsDocument(payload.footprints ?? null);
      setConnectivityRoute(null);
      setNavmeshRoute(null);
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
    setConnectivityGraph(null);
    setEntitiesExtract(null);
    setFootprintsDocument(null);
    setConnectivityRoute(null);
    setNavmeshRoute(null);
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
      connectivityGraph,
      entitiesExtract,
      footprintsDocument,
      connectivityRoute,
      setConnectivityRoute,
      navmeshRoute,
      setNavmeshRoute,
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
      connectivityGraph,
      entitiesExtract,
      footprintsDocument,
      connectivityRoute,
      navmeshRoute,
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
