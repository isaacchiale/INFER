import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Maximize2 } from "lucide-react";
import { computeRoute } from "@/api/routing";
import {
  buildModelGraph,
  computeModelRoute,
  getModelGraph,
} from "@/api/models";
import { useInfer } from "@/state/infer-store";
import { useAppTheme } from "@/hooks/use-app-theme";
import { buildGraphLayout, deriveStoreyBands, graphPalette } from "@/lib/graph-layout";
import {
  createCytoscapeRuntime,
  type CytoscapeRuntime,
} from "@/viewer/cytoscape-runtime";
import type { GraphLayout } from "@/lib/graph-layout";
import type { GraphNode, GraphVariant, RouteResult } from "@/types/graph";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const EMPTY = "—";
const EMPTY_LAYOUT: GraphLayout = { nodes: [], edges: [], width: 1, height: 1 };

const VARIANT_OPTIONS: { id: GraphVariant; label: string }[] = [
  { id: "ifc", label: "IFC relations" },
  { id: "geometry", label: "Geometry rules" },
  { id: "topologic", label: "TopologicPy" },
];

const GLASS =
  "rounded-[6px] border border-border bg-background/90 shadow-sm backdrop-blur-[2px]";

function shortLabel(node: GraphNode): string {
  if (node.code) return node.code;
  const name = (node.name || "").trim();
  if (name) return name.length > 24 ? `${name.slice(0, 22)}…` : name;
  return node.global_id.slice(0, 8);
}

export function GraphViewer({ className }: { className?: string }) {
  const {
    connectivityGraph,
    entitiesExtract,
    backendModelId,
    graphSource,
    setConnectivityRoute,
    setConnectivityGraphOnly,
  } = useInfer();
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
    () => (graph && hasGraph ? buildGraphLayout(graph, bands) : null),
    [graph, bands, hasGraph],
  );

  /** Include edge inferred flags so green styling refreshes on variant switch. */
  const layoutFingerprint = useMemo(() => {
    if (!layout?.nodes.length) return "";
    const nodes = layout.nodes.map((n) => `${n.id}:${n.x.toFixed(1)}:${n.y.toFixed(1)}`).join("|");
    const edges = layout.edges.map((e) => `${e.id}:${e.inferred ? 1 : 0}`).join("|");
    return `${nodes}#${edges}#${variant}`;
  }, [layout, variant]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<CytoscapeRuntime | null>(null);
  const layoutRef = useRef<GraphLayout | null>(null);
  const themeRef = useRef(theme);
  const fittedGraphIdRef = useRef<string | null>(null);
  const clickMode = useRef<"origin" | "destination">("origin");
  const [engineReady, setEngineReady] = useState(false);
  const [cyError, setCyError] = useState<string | null>(null);

  layoutRef.current = layout;
  themeRef.current = theme;
  const graphId = graph ? `${graph.model_id}:${variant}` : null;

  const spaceOptions = useMemo(
    () => (graph ? graph.nodes.filter((n) => n.kind === "space") : []),
    [graph],
  );

  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    if (!graph) {
      setOrigin("");
      setDestination("");
      setRoute(null);
      setConnectivityRoute(null);
      setError(null);
      return;
    }
    const spaces = graph.nodes.filter((n) => n.kind === "space");
    if (!spaces.length) {
      setOrigin("");
      setDestination("");
      return;
    }
    const ids = new Set(spaces.map((s) => s.id));
    const first = spaces[0];
    const second = spaces[Math.min(1, spaces.length - 1)];
    if (!first || !second) return;
    setOrigin((prev) => (prev && ids.has(prev) ? prev : first.id));
    setDestination((prev) => (prev && ids.has(prev) ? prev : second.id));
  }, [graph]);

  useEffect(() => {
    let cancelled = false;
    if (!graph || !origin || !destination) {
      setRoute(null);
      setConnectivityRoute(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);

    const run =
      backendModelId && graphSource === "model"
        ? computeModelRoute(backendModelId, {
            origin_node_id: origin,
            destination_node_id: destination,
            graph_variant: variant,
          })
        : computeRoute({
            origin_node_id: origin,
            destination_node_id: destination,
            graph,
          });

    void run
      .then((result) => {
        if (!cancelled) {
          setRoute(result);
          setConnectivityRoute(result);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRoute(null);
          setConnectivityRoute(null);
          setError(err instanceof Error ? err.message : "Route failed");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [origin, destination, backendModelId, graphSource, graph, variant, setConnectivityRoute]);

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
          if (clickMode.current === "origin") {
            setOrigin(id);
            clickMode.current = "destination";
          } else {
            setDestination(id);
            clickMode.current = "origin";
          }
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
    const next = layoutRef.current ?? EMPTY_LAYOUT;
    const id = graphId ?? (next.nodes.length ? "layout" : null);
    const shouldFit = Boolean(id && id !== fittedGraphIdRef.current && next.nodes.length);
    if (shouldFit) fittedGraphIdRef.current = id;
    runtimeRef.current.setLayout(next, { fit: shouldFit });
  }, [layoutFingerprint, engineReady, graphId]);

  useEffect(() => {
    if (!engineReady || !runtimeRef.current) return;
    const pathNodes = route?.found ? (route.node_ids ?? []) : [];
    const pathEdgeIds = route?.found ? (route.edge_ids ?? []) : [];
    const selected = [origin, destination].filter(Boolean);
    runtimeRef.current.setPath(pathNodes, pathEdgeIds, selected);
  }, [route, origin, destination, engineReady]);

  const pathLabel = !hasGraph
    ? EMPTY
    : busy
      ? "…"
      : route?.found
        ? `${route.hops} hops`
        : EMPTY;

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
          {(variant === "geometry" || variant === "topologic") && (
            <div className="pointer-events-none flex flex-wrap gap-2 rounded-md border border-border/80 bg-background/90 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-0.5 w-3 bg-slate-500" /> IFC
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-0.5 w-3 bg-[#22c55e]" /> Inferred
              </span>
            </div>
          )}
          {variantBusy && (
            <span className="text-[10px] text-muted-foreground">Loading variant…</span>
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
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm font-medium">No graph loaded</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Open an IFC model to build the connectivity graph.
            </p>
          </div>
        )}
        {hasGraph && !engineReady && !cyError && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-[13px] text-muted-foreground">
            Starting graph viewer…
          </div>
        )}
        {cyError && (
          <div className="absolute inset-x-0 bottom-2 z-50 mx-3 rounded-md border border-destructive/40 bg-background/95 px-3 py-2 text-[11px] text-destructive">
            Graph render error: {cyError}
          </div>
        )}
      </div>

      <div className="relative z-10 shrink-0 border-t border-border bg-surface-raised px-3 py-2 text-[12px]">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[11px] text-amber-500">
            {!error && route && !route.found && hasGraph ? "No path exists" : null}
          </p>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {graphSource === "model"
              ? `Live · ${VARIANT_OPTIONS.find((o) => o.id === variant)?.label ?? variant}`
              : EMPTY}
          </span>
        </div>
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
          <span>
            Topology Size:{" "}
            <strong>{hasGraph ? `${spaceOptions.length} rooms` : EMPTY}</strong>
          </span>
          <span>
            Network Connections:{" "}
            <strong>{hasGraph ? `${graph!.edges.length} links` : EMPTY}</strong>
          </span>
          <span className={cn(route?.found && "text-primary")}>
            Shortest Path: <strong>{pathLabel}</strong>
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-0.5 text-[11px] text-muted-foreground">
            Start Room
            <select
              className="h-8 min-w-[120px] max-w-[200px] rounded-md border border-input bg-background px-2 text-xs text-foreground disabled:opacity-60"
              value={origin}
              disabled={!spaceOptions.length}
              onChange={(e) => setOrigin(e.target.value)}
            >
              {!spaceOptions.length ? (
                <option value="">{EMPTY}</option>
              ) : (
                spaceOptions.map((n) => (
                  <option key={n.id} value={n.id}>
                    {shortLabel(n)}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="grid gap-0.5 text-[11px] text-muted-foreground">
            Target Room
            <select
              className="h-8 min-w-[120px] max-w-[200px] rounded-md border border-input bg-background px-2 text-xs text-foreground disabled:opacity-60"
              value={destination}
              disabled={!spaceOptions.length}
              onChange={(e) => setDestination(e.target.value)}
            >
              {!spaceOptions.length ? (
                <option value="">{EMPTY}</option>
              ) : (
                spaceOptions.map((n) => (
                  <option key={n.id} value={n.id}>
                    {shortLabel(n)}
                  </option>
                ))
              )}
            </select>
          </label>
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}
