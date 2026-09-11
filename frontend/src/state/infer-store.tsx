import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import {
  accessibleRoute,
  defaultLayers,
  defaultRoute,
  hazardZones as mockHazards,
  scenario as mockScenario,
} from "@/data/mock";
import type {
  AgentProfileId,
  HazardZone,
  LayerId,
  LayerState,
  Route,
  RouteMode,
  RouteRestriction,
  ScenarioCondition,
} from "@/types/infer";
import type { ConnectivityGraph, RouteResult } from "@/types/graph";
import type { EntitiesExtract } from "@/api/models";
import type { FootprintsDocument, Point2D } from "@/types/footprints";
import type { ViewerCameraPose, ThreeAabb, Mat4Elements } from "@/lib/viewer-camera-pose";

export type WorkMode = "model" | "navigate" | "layers" | "validate" | "scenario";

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

export interface RouteRequest {
  origin: string;
  destination: string;
  profile: AgentProfileId;
  mode: RouteMode;
  restrictions: RouteRestriction[];
}

/**
 * The store is split into several contexts by how often each group changes
 * and who actually reads it, instead of one big InferState — bundling
 * everything meant e.g. typing in ScenarioPanel (ScenarioState) re-rendered
 * the 3D viewport and Floorplan (which only ever read ViewportState /
 * ModelDataState). Heavy render consumers (FloorplanViewer, GraphViewer,
 * InferModelViewport, the workspace route) call the specific hook(s) they
 * need; everything else keeps using the combined useInfer() below.
 *
 * ViewerPoseState (viewerCameraPose etc.) was already split out earlier for
 * the same reason — it publishes at up to 20Hz during Fly navigation.
 */
interface ViewportState {
  workMode: WorkMode;
  setWorkMode: (m: WorkMode) => void;

  activeStoreyId: string | "all";
  setActiveStoreyId: (id: string | "all") => void;
  layers: LayerState[];
  toggleLayer: (id: LayerId) => void;
  setAllLayers: (visible: boolean) => void;

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
  graphSource: "demo" | "model" | "none";
  setModelGraph: (payload: {
    modelId: string;
    graph: ConnectivityGraph;
    entities: EntitiesExtract;
    footprints?: FootprintsDocument | null;
  }) => void;
  clearModelGraph: () => void;
}

interface ScenarioState {
  // routing
  request: RouteRequest;
  updateRequest: (patch: Partial<RouteRequest>) => void;
  route: Route | null;
  computing: boolean;
  computeRoute: () => void;
  clearRoute: () => void;

  // animation
  animation: { playing: boolean; stepIndex: number };
  play: () => void;
  pause: () => void;
  stepForward: () => void;
  resetAnimation: () => void;

  // scenario
  conditions: ScenarioCondition[];
  addCondition: (c: ScenarioCondition) => void;
  removeCondition: (id: string) => void;
  undoRemove: () => void;
  hazardZones: HazardZone[];

  // validation
  selectedIssueId: string | null;
  setSelectedIssueId: (id: string | null) => void;
}

/** Combined shape returned by useInfer() — every field from every context. */
type InferState = ViewportState & ModelDataState & ScenarioState;

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
  const [workMode, setWorkMode] = useState<WorkMode>("model");
  const [activeStoreyId, setActiveStoreyId] = useState<string | "all">("all");
  const [layers, setLayers] = useState<LayerState[]>(defaultLayers);
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [pendingIfc, setPendingIfc] = useState<{ name: string; buffer: Uint8Array } | null>(
    null,
  );
  const [viewerStatus, setViewerStatusMessage] = useState("3D viewer idle");
  const [viewerStatusKind, setViewerStatusKind] = useState<"info" | "error" | "loading">(
    "info",
  );

  const toggleLayer = useCallback((id: LayerId) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  }, []);
  const setAllLayers = useCallback((visible: boolean) => {
    setLayers((prev) => prev.map((l) => ({ ...l, visible })));
  }, []);

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
      workMode,
      setWorkMode,
      activeStoreyId,
      setActiveStoreyId,
      layers,
      toggleLayer,
      setAllLayers,
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
      workMode,
      activeStoreyId,
      layers,
      toggleLayer,
      setAllLayers,
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

const ScenarioCtx = createContext<ScenarioState | null>(null);

function ScenarioProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<RouteRequest>({
    origin: "Meeting Room 03-12",
    destination: "Exit E-02",
    profile: "visitor",
    mode: "fastest",
    restrictions: ["avoid-hazards"],
  });
  const [route, setRoute] = useState<Route | null>(defaultRoute);
  const [computing, setComputing] = useState(false);
  const [animation, setAnimation] = useState({ playing: false, stepIndex: 0 });
  const [conditions, setConditions] = useState<ScenarioCondition[]>(mockScenario.conditions);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const removedRef = useRef<ScenarioCondition | null>(null);

  const updateRequest = useCallback((patch: Partial<RouteRequest>) => {
    setRequest((prev) => ({ ...prev, ...patch }));
  }, []);

  const computeRoute = useCallback(() => {
    setComputing(true);
    setAnimation({ playing: false, stepIndex: 0 });
    window.setTimeout(() => {
      setRoute((_prev) => {
        const base = request.mode === "accessible" || request.profile === "wheelchair" ? accessibleRoute : defaultRoute;
        return {
          ...base,
          label: `${request.origin} → ${request.destination}`,
          mode: request.mode,
          profile: request.profile,
        };
      });
      setComputing(false);
    }, 700);
  }, [request]);

  const clearRoute = useCallback(() => {
    setRoute(null);
    setAnimation({ playing: false, stepIndex: 0 });
  }, []);

  const play = useCallback(() => setAnimation((a) => ({ ...a, playing: true })), []);
  const pause = useCallback(() => setAnimation((a) => ({ ...a, playing: false })), []);
  const stepForward = useCallback(
    () =>
      setAnimation((a) => ({
        playing: false,
        stepIndex: Math.min(a.stepIndex + 1, (route?.steps.length ?? 1) - 1),
      })),
    [route],
  );
  const resetAnimation = useCallback(() => setAnimation({ playing: false, stepIndex: 0 }), []);

  const addCondition = useCallback((c: ScenarioCondition) => setConditions((p) => [c, ...p]), []);
  const removeCondition = useCallback((id: string) => {
    setConditions((p) => {
      removedRef.current = p.find((c) => c.id === id) ?? null;
      return p.filter((c) => c.id !== id);
    });
  }, []);
  const undoRemove = useCallback(() => {
    if (removedRef.current) {
      setConditions((p) => [removedRef.current as ScenarioCondition, ...p]);
      removedRef.current = null;
    }
  }, []);

  const value = useMemo<ScenarioState>(
    () => ({
      request,
      updateRequest,
      route,
      computing,
      computeRoute,
      clearRoute,
      animation,
      play,
      pause,
      stepForward,
      resetAnimation,
      conditions,
      addCondition,
      removeCondition,
      undoRemove,
      hazardZones: mockHazards,
      selectedIssueId,
      setSelectedIssueId,
    }),
    [
      request,
      updateRequest,
      route,
      computing,
      computeRoute,
      clearRoute,
      animation,
      play,
      pause,
      stepForward,
      resetAnimation,
      conditions,
      addCondition,
      removeCondition,
      undoRemove,
      selectedIssueId,
    ],
  );

  return <ScenarioCtx.Provider value={value}>{children}</ScenarioCtx.Provider>;
}

export function useScenario(): ScenarioState {
  const ctx = useContext(ScenarioCtx);
  if (!ctx) throw new Error("useScenario must be used inside InferProvider");
  return ctx;
}

export function InferProvider({ children }: { children: ReactNode }) {
  return (
    <ViewerPoseProvider>
      <ViewportProvider>
        <ModelDataProvider>
          <ScenarioProvider>{children}</ScenarioProvider>
        </ModelDataProvider>
      </ViewportProvider>
    </ViewerPoseProvider>
  );
}

/**
 * Combined view of every context below ViewerPoseState — kept for the many
 * lightweight consumers (panels, toolbars, the ingest dialog) where
 * subscribing to everything costs nothing. Render-heavy consumers
 * (FloorplanViewer, GraphViewer, InferModelViewport, the workspace route)
 * call useViewport()/useModelData()/useScenario() directly instead, so a
 * change in one doesn't re-render a component that only reads another.
 */
export function useInfer(): InferState {
  const viewport = useViewport();
  const modelData = useModelData();
  const scenario = useScenario();
  return useMemo(
    () => ({ ...viewport, ...modelData, ...scenario }),
    [viewport, modelData, scenario],
  );
}
