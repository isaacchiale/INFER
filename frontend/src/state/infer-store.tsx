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

export type WorkMode = "model" | "navigate" | "layers" | "validate" | "scenario";

export type StoreyDisplayMode = "all" | "isolate" | "ghost" | "explode";

export interface RouteRequest {
  origin: string;
  destination: string;
  profile: AgentProfileId;
  mode: RouteMode;
  restrictions: RouteRestriction[];
}

interface InferState {
  // mode
  workMode: WorkMode;
  setWorkMode: (m: WorkMode) => void;

  // viewport
  activeStoreyId: string | "all";
  setActiveStoreyId: (id: string | "all") => void;
  storeyMode: StoreyDisplayMode;
  setStoreyMode: (m: StoreyDisplayMode) => void;
  layers: LayerState[];
  toggleLayer: (id: LayerId) => void;
  setAllLayers: (visible: boolean) => void;

  // selection
  selectedElementIds: string[];
  selectElement: (id: string | null) => void;

  // routing
  request: RouteRequest;
  updateRequest: (patch: Partial<RouteRequest>) => void;
  route: Route | null;
  computing: boolean;
  computeRoute: () => void;
  clearRoute: () => void;
  comparison: { original: Route; revised: Route } | null;
  setComparison: (c: { original: Route; revised: Route } | null) => void;

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

  // chrome
  panelCollapsed: boolean;
  setPanelCollapsed: (v: boolean) => void;
  railCollapsed: boolean;
  setRailCollapsed: (v: boolean) => void;
  statusExpanded: boolean;
  setStatusExpanded: (v: boolean) => void;
  emergencyMode: boolean;
  setEmergencyMode: (v: boolean) => void;
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

const Ctx = createContext<InferState | null>(null);

export function InferProvider({ children }: { children: ReactNode }) {
  const [workMode, setWorkMode] = useState<WorkMode>("model");
  const [activeStoreyId, setActiveStoreyId] = useState<string | "all">("all");
  const [storeyMode, setStoreyMode] = useState<StoreyDisplayMode>("all");
  const [layers, setLayers] = useState<LayerState[]>(defaultLayers);
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  const [request, setRequest] = useState<RouteRequest>({
    origin: "Meeting Room 03-12",
    destination: "Exit E-02",
    profile: "visitor",
    mode: "fastest",
    restrictions: ["avoid-hazards"],
  });
  const [route, setRoute] = useState<Route | null>(defaultRoute);
  const [computing, setComputing] = useState(false);
  const [comparison, setComparison] = useState<{ original: Route; revised: Route } | null>(null);
  const [animation, setAnimation] = useState({ playing: false, stepIndex: 0 });
  const [conditions, setConditions] = useState<ScenarioCondition[]>(mockScenario.conditions);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [emergencyMode, setEmergencyMode] = useState(false);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [pendingIfc, setPendingIfc] = useState<{ name: string; buffer: Uint8Array } | null>(
    null,
  );
  const [viewerStatus, setViewerStatusMessage] = useState("3D viewer idle");
  const [viewerStatusKind, setViewerStatusKind] = useState<"info" | "error" | "loading">(
    "info",
  );
  const removedRef = useRef<ScenarioCondition | null>(null);

  const queueIfcFile = useCallback(async (file: File) => {
    const buffer = new Uint8Array(await file.arrayBuffer());
    setPendingIfc({ name: file.name, buffer });
  }, []);

  const clearPendingIfc = useCallback(() => setPendingIfc(null), []);

  const setViewerStatus = useCallback(
    (message: string, kind: "info" | "error" | "loading" = "info") => {
      setViewerStatusMessage(message);
      setViewerStatusKind(kind);
    },
    [],
  );

  const toggleLayer = useCallback((id: LayerId) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  }, []);
  const setAllLayers = useCallback((visible: boolean) => {
    setLayers((prev) => prev.map((l) => ({ ...l, visible })));
  }, []);

  const selectElement = useCallback((id: string | null) => {
    setSelectedElementIds(id ? [id] : []);
  }, []);

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
    setComparison(null);
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

  const value = useMemo<InferState>(
    () => ({
      workMode,
      setWorkMode,
      activeStoreyId,
      setActiveStoreyId,
      storeyMode,
      setStoreyMode,
      layers,
      toggleLayer,
      setAllLayers,
      selectedElementIds,
      selectElement,
      request,
      updateRequest,
      route,
      computing,
      computeRoute,
      clearRoute,
      comparison,
      setComparison,
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
      panelCollapsed,
      setPanelCollapsed,
      railCollapsed,
      setRailCollapsed,
      statusExpanded,
      setStatusExpanded,
      emergencyMode,
      setEmergencyMode,
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
      storeyMode,
      layers,
      toggleLayer,
      setAllLayers,
      selectedElementIds,
      selectElement,
      request,
      updateRequest,
      route,
      computing,
      computeRoute,
      clearRoute,
      comparison,
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
      panelCollapsed,
      railCollapsed,
      statusExpanded,
      emergencyMode,
      ingestOpen,
      pendingIfc,
      queueIfcFile,
      clearPendingIfc,
      viewerStatus,
      setViewerStatus,
      viewerStatusKind,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useInfer() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useInfer must be used inside InferProvider");
  return ctx;
}
