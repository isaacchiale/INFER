import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FolderOpen, Layers, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  buildModelGraph,
  getModelGraph,
  rehealModelGraph,
} from "@/api/models";
import { useModelData, useViewport } from "@/state/infer-store";
import { useAppTheme } from "@/hooks/use-app-theme";
import {
  buildGraphLayout,
  deriveStoreyBands,
  graphPalette,
} from "@/lib/graph-layout";
import { exclusionNodeLabel, toastExclusionToggle } from "@/lib/exclusion-toast";
import {
  createCytoscapeRuntime,
  type CytoscapeRuntime,
} from "@/viewer/cytoscape-runtime";
import type { GraphLayout } from "@/lib/graph-layout";
import type { GraphVariant } from "@/types/graph";
import { cn } from "@/lib/utils";
import { GLASS } from "@/lib/floating-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const EMPTY = "—";
const EMPTY_LAYOUT: GraphLayout = { nodes: [], edges: [], width: 1, height: 1, cellW: 1, cellH: 1 };

const VARIANT_OPTIONS: { id: GraphVariant; label: string }[] = [
  { id: "ifc", label: "IFC relations" },
  { id: "geometry", label: "Geometry rules" },
];

export function GraphViewer({ className }: { className?: string }) {
  const {
    connectivityGraph,
    entitiesExtract,
    backendModelId,
    graphSource,
    setConnectivityRoute,
    setConnectivityGraphOnly,
    excludedNodeIds,
    toggleExcludedNode,
    excludedEdgeIds,
    toggleExcludedEdge,
    navmeshRoute,
  } = useModelData();
  const { selectedElementIds, focusedElementId, selectElement, setFocusedElementId, setIngestOpen } =
    useViewport();
  const theme = useAppTheme();
  const graph = connectivityGraph;
  const hasGraph = Boolean(graph && graph.nodes.length > 0);
  const palette = graphPalette(theme);

  const [variant, setVariant] = useState<GraphVariant>(
    () => connectivityGraph?.variant ?? "ifc",
  );
  const [variantBusy, setVariantBusy] = useState(false);
  const [variantError, setVariantError] = useState<string | null>(null);

  const bands = useMemo(
    () => (graph ? deriveStoreyBands(graph, entitiesExtract) : []),
    [graph, entitiesExtract],
  );

  const layout = useMemo(
    () =>
      graph && hasGraph
        ? buildGraphLayout(graph, bands, excludedNodeIds, excludedEdgeIds)
        : null,
    [graph, bands, hasGraph, excludedNodeIds, excludedEdgeIds],
  );

  /** Include edge inferred flags so green styling refreshes on variant switch. */
  const layoutFingerprint = useMemo(() => {
    if (!layout?.nodes.length) return "";
    const nodes = layout.nodes
      .map((n) => `${n.id}:${n.x.toFixed(1)}:${n.y.toFixed(1)}:${n.excluded ? 1 : 0}`)
      .join("|");
    const edges = layout.edges
      .map(
        (e) =>
          `${e.id}:${e.inferred ? 1 : 0}:${e.heal ?? ""}:${e.excluded ? 1 : 0}`,
      )
      .join("|");
    const excludedKey = [...excludedNodeIds].sort().join(",");
    const excludedEdgesKey = [...excludedEdgeIds].sort().join(",");
    return `${nodes}#${edges}#${variant}#${excludedKey}#${excludedEdgesKey}`;
  }, [layout, variant, excludedNodeIds, excludedEdgeIds]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<CytoscapeRuntime | null>(null);
  const layoutRef = useRef<GraphLayout | null>(null);
  const themeRef = useRef(theme);
  const fittedGraphIdRef = useRef<string | null>(null);
  const toggleExcludedRef = useRef(toggleExcludedNode);
  toggleExcludedRef.current = toggleExcludedNode;
  const toggleExcludedEdgeRef = useRef(toggleExcludedEdge);
  toggleExcludedEdgeRef.current = toggleExcludedEdge;
  const excludedNodeIdsRef = useRef(excludedNodeIds);
  excludedNodeIdsRef.current = excludedNodeIds;
  const excludedEdgeIdsRef = useRef(excludedEdgeIds);
  excludedEdgeIdsRef.current = excludedEdgeIds;
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const selectElementRef = useRef(selectElement);
  selectElementRef.current = selectElement;
  const setFocusedElementIdRef = useRef(setFocusedElementId);
  setFocusedElementIdRef.current = setFocusedElementId;
  const [engineReady, setEngineReady] = useState(false);
  const [cyError, setCyError] = useState<string | null>(null);

  layoutRef.current = layout;
  themeRef.current = theme;
  const graphId = graph ? `${graph.model_id}:${variant}` : null;

  const spaceCount = useMemo(
    () =>
      graph
        ? graph.nodes.filter((n) => n.kind === "space" && !excludedNodeIds.has(n.id)).length
        : 0,
    [graph, excludedNodeIds],
  );

  // Sync dropdown when a new model is ingested (defaults to IFC).
  useEffect(() => {
    if (!connectivityGraph) {
      setVariant("ifc");
      return;
    }
    if (connectivityGraph.variant) setVariant(connectivityGraph.variant);
  }, [connectivityGraph?.model_id]);

  const loadVariant = async (next: GraphVariant) => {
    if (!backendModelId) {
      setVariantError("Ingest a model to switch graph variants.");
      return;
    }
    setVariantBusy(true);
    setVariantError(null);
    try {
      let g;
      try {
        g = await getModelGraph(backendModelId, next);
      } catch {
        g = await buildModelGraph(backendModelId, next);
      }
      setConnectivityGraphOnly(g);
      setVariant(next);
      fittedGraphIdRef.current = null;
      runtimeRef.current?.fit();
    } catch (err) {
      setVariantError(err instanceof Error ? err.message : "Failed to load graph variant");
    } finally {
      setVariantBusy(false);
    }
  };

  // Room→room routing moved to floorplan navmesh click-to-click.
  useEffect(() => {
    setConnectivityRoute(null);
  }, [graphId, setConnectivityRoute]);

  const liveRehealRef = useRef(false);
  useEffect(() => {
    if (variant !== "geometry" || !backendModelId || graphSource !== "model") {
      return;
    }
    const ids = [...excludedNodeIds];
    if (!ids.length && !liveRehealRef.current) {
      return;
    }
    let cancelled = false;
    setVariantBusy(true);
    setVariantError(null);
    const run = ids.length
      ? rehealModelGraph(backendModelId, ids)
      : getModelGraph(backendModelId, "geometry");
    void run
      .then((g) => {
        if (cancelled) return;
        liveRehealRef.current = ids.length > 0;
        setConnectivityGraphOnly(g);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setVariantError(err instanceof Error ? err.message : "Failed to recalculate geometry");
        }
      })
      .finally(() => {
        if (!cancelled) setVariantBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [backendModelId, excludedNodeIds, graphSource, setConnectivityGraphOnly, variant]);

  // Boot Cytoscape once — same pattern as InferModelViewport / That Open.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;

    void (async () => {
      try {
        const runtime = await createCytoscapeRuntime(host, themeRef.current);
        if (disposed) {
          runtime.destroy();
          return;
        }
        runtimeRef.current = runtime;
        runtime.onSpaceTap((id) => {
          selectElementRef.current(id);
        });
        runtime.onEdgeTap((id) => {
          selectElementRef.current(`portal:${id}`);
        });
        runtime.onBackgroundTap(() => {
          setFocusedElementIdRef.current(null);
        });
        runtime.onNodeCxtTap((id) => {
          const wasExcluded = excludedNodeIdsRef.current.has(id);
          toggleExcludedRef.current(id);
          const node = graphRef.current?.nodes.find((n) => n.id === id);
          toastExclusionToggle({
            label: exclusionNodeLabel(id, node?.name),
            wasExcluded,
            kind: "node",
            onUndo: () => toggleExcludedRef.current(id),
          });
        });
        runtime.onEdgeCxtTap((id) => {
          const wasExcluded = excludedEdgeIdsRef.current.has(id);
          toggleExcludedEdgeRef.current(id);
          const layoutEdge = layoutRef.current?.edges.find((e) => e.id === id);
          const sourceName = graphRef.current?.nodes.find((n) => n.id === layoutEdge?.source)?.name;
          const targetName = graphRef.current?.nodes.find((n) => n.id === layoutEdge?.target)?.name;
          const label =
            sourceName?.trim() && targetName?.trim()
              ? `${sourceName.trim()} ↔ ${targetName.trim()}`
              : "Connection";
          toastExclusionToggle({
            label,
            wasExcluded,
            kind: "edge",
            onUndo: () => toggleExcludedEdgeRef.current(id),
          });
        });
        runtime.setTheme(themeRef.current);
        // Layout + fit come only from the layout effect — avoid a double setLayout
        // race that cancels the first fit and re-frames while the user zooms.
        setEngineReady(true);
        setCyError(null);
      } catch (err) {
        console.error(err);
        if (!disposed) {
          setCyError(err instanceof Error ? err.message : "Failed to init graph viewer");
          setEngineReady(false);
        }
      }
    })();

    return () => {
      disposed = true;
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
      setEngineReady(false);
    };
  }, []);

  useEffect(() => {
    if (!engineReady || !runtimeRef.current) return;
    runtimeRef.current.setTheme(theme);
  }, [theme, engineReady]);

  useEffect(() => {
    if (!engineReady || !runtimeRef.current) return;
    runtimeRef.current.setExcludedEdges(excludedEdgeIds);
  }, [excludedEdgeIds, engineReady, layoutFingerprint]);

  useEffect(() => {
    if (!engineReady || !runtimeRef.current) return;
    const next = layoutRef.current ?? EMPTY_LAYOUT;
    const id = graphId ?? (next.nodes.length ? "layout" : null);
    const shouldFit = Boolean(id && id !== fittedGraphIdRef.current && next.nodes.length);
    if (shouldFit) fittedGraphIdRef.current = id;
    runtimeRef.current.setLayout(next, { fit: shouldFit });
  }, [layoutFingerprint, engineReady, graphId]);

  useEffect(() => {
    if (!engineReady || !runtimeRef.current) return;
    const selected = selectedElementIds.filter((id) => id.startsWith("space:"));
    const selectedEdges = selectedElementIds
      .filter((id) => id.startsWith("portal:"))
      .map((id) => id.slice("portal:".length));
    const pathIds = (navmeshRoute?.graphNodeIds ?? []).filter((id) => !excludedNodeIds.has(id));
    const focused = focusedElementId?.startsWith("portal:")
      ? focusedElementId.slice("portal:".length)
      : focusedElementId;
    runtimeRef.current.setPath(pathIds, [], selected, selectedEdges, focused);
  }, [
    selectedElementIds,
    focusedElementId,
    excludedNodeIds,
    engineReady,
    navmeshRoute?.graphNodeIds,
  ]);

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col bg-background text-foreground",
        className,
      )}
    >
      <div className="relative min-h-0 min-w-0 flex-1">
        <div
          ref={hostRef}
          className="absolute inset-0 z-0 select-none overflow-hidden"
          style={{
            background: palette.bg,
            touchAction: "none",
            overscrollBehavior: "contain",
          }}
          aria-label="Connectivity graph canvas"
          title="Left-click space or link: select/deselect (multi). Right-click node: remove or restore. Right-click link: disable or restore (dashed). Pathfinding: right-click start/end on the floorplan navmesh."
        />
        <div className="pointer-events-none absolute left-2 top-2 z-50 flex flex-col items-start gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={!backendModelId || variantBusy}
                className={cn(
                  GLASS,
                  "pointer-events-auto inline-flex h-8 max-w-[220px] items-center gap-1.5 px-2.5 text-[11px] text-foreground disabled:opacity-40",
                )}
                title="Select connectivity graph variant"
              >
                <span className="truncate">
                  {VARIANT_OPTIONS.find((o) => o.id === variant)?.label ?? variant}
                </span>
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[12rem]">
              {VARIANT_OPTIONS.map((o) => {
                const active = variant === o.id;
                return (
                  <DropdownMenuItem
                    key={o.id}
                    className="text-[12px]"
                    onSelect={() => {
                      if (o.id !== variant) void loadVariant(o.id);
                    }}
                  >
                    {active ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                    {o.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          {variantBusy && (
            <span className="text-[10px] text-muted-foreground">
              {variant === "geometry" && excludedNodeIds.size > 0
                ? "Recalculating geometry…"
                : "Loading variant…"}
            </span>
          )}
          {variantError && (
            <span className="max-w-[240px] text-[10px] text-destructive">{variantError}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => runtimeRef.current?.fit()}
          disabled={!hasGraph || !engineReady}
          className="pointer-events-auto absolute right-2 top-2 z-50 inline-flex items-center gap-1 rounded-[6px] border border-border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur-[2px] transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          title="Zoom to show the entire graph"
        >
          <Maximize2 className="size-3" />
          Fit
        </button>
        {!hasGraph && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm font-medium">No graph loaded</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Open an IFC model to build the connectivity graph.
            </p>
            <Button size="sm" className="pointer-events-auto" onClick={() => setIngestOpen(true)}>
              <FolderOpen aria-hidden />
              Open model
            </Button>
          </div>
        )}
        {hasGraph && !engineReady && !cyError && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-[13px] text-muted-foreground">
            Starting graph viewer…
          </div>
        )}
        {cyError && (
          <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-50 rounded-md border border-destructive/40 bg-background/95 px-2 py-1.5 text-[11px] text-destructive backdrop-blur-sm">
            Graph render error: {cyError}
          </div>
        )}
        {!cyError && (
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
              <DropdownMenuContent align="start" className="w-52 text-[12px]">
                <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                  Legend
                </DropdownMenuLabel>
                <div className="flex flex-col gap-1.5 px-2 pb-2 text-foreground">
                  {variant === "geometry" ? (
                    <>
                      <div className="flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-3 bg-portal-door" /> IFC door
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-3 bg-portal-door-heal" /> Door heal
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-3 bg-portal-space" /> Space heal
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-3 bg-stair-glyph" /> Stair
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-0.5 w-3 bg-portal-door" /> IFC relation
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block size-2.5 rounded-full border-2 border-[var(--route-normal)] bg-transparent" />
                    Route hop
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block size-2.5 rounded-sm bg-selection" /> Selected
                  </div>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            <span>
              <span className="font-medium text-foreground">
                {hasGraph ? spaceCount : EMPTY}
              </span>{" "}
              rooms
            </span>
            <span>
              <span className="font-medium text-foreground">
                {hasGraph ? graph!.edges.length : EMPTY}
              </span>{" "}
              links
            </span>
            <span className="text-muted-foreground/80">
              {graphSource === "model"
                ? `Live · ${VARIANT_OPTIONS.find((o) => o.id === variant)?.label ?? variant}`
                : EMPTY}
            </span>
            {(excludedNodeIds.size > 0 || excludedEdgeIds.size > 0) && (
              <span className="min-w-0 truncate">
                {[
                  excludedNodeIds.size > 0
                    ? `${excludedNodeIds.size} node${excludedNodeIds.size === 1 ? "" : "s"} removed`
                    : null,
                  excludedEdgeIds.size > 0
                    ? `${excludedEdgeIds.size} link${excludedEdgeIds.size === 1 ? "" : "s"} disabled`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}{" "}
                — right-click to restore
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
