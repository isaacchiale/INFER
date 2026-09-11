import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Check, ChevronDown, Move3d, Network, PersonStanding } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildAllStoreyNavmeshes, buildStoreyNavmesh } from "@/lib/navmesh";
import {
  buildPlanRouteTubePolylines,
  buildRouteTubePolylines,
  resolveRouteTubeLiftOptions,
} from "@/lib/route-tube";
import {
  elevationsForVerticalRemap,
  normalizeElevationsToMetres,
} from "@/lib/storey-elevations";
import {
  ifcPlanToThree,
  liftPlanPolylineToThree,
  type Mat4Elements,
  type ThreeAabb,
} from "@/lib/viewer-camera-pose";
import type { HazardZone, Route } from "@/types/infer";
import { useModelData, useViewport, useViewerPose, type NavmeshRoute } from "@/state/infer-store";
import {
  createThatOpenRuntime,
  type GeometryDisplayMode,
  type NavMode,
  type StoreyFilter,
  type ThatOpenRuntime,
} from "@/viewer/that-open-runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const GLASS =
  "rounded-[6px] border border-border bg-background/90 shadow-sm backdrop-blur-[2px]";

/** Navmesh slabs sit just above each storey elevation. */
const NAVMESH_HEIGHT_OFFSET_M = 0.05;

type TubeLiftArgs = Parameters<typeof buildPlanRouteTubePolylines>[0];

/**
 * Lifts a click-to-click navmesh route into the blue tube. A cross-storey
 * route (`segments`) gets one tube per storey it crosses — the same
 * "separate per-storey tubes, no ramp" convention buildRouteTubePolylines
 * already uses for the backend-computed multi-floor route, since there's no
 * real stair/ramp geometry to trace between floors. A same-storey route
 * falls back to a single lift.
 */
function buildNavmeshRouteTube(
  route: NavmeshRoute | null | undefined,
  footprints: TubeLiftArgs["footprints"],
  modelBounds: ThreeAabb | null,
  coordInverse: Mat4Elements | null,
): ReturnType<typeof buildPlanRouteTubePolylines> {
  if (!route) return null;
  if (route.segments?.length) {
    const polylines = route.segments.flatMap(
      (seg) =>
        buildPlanRouteTubePolylines({
          points: seg.points,
          storeyId: seg.storeyId,
          footprints,
          modelBounds,
          coordInverse,
        }) ?? [],
    );
    return polylines.length ? polylines : null;
  }
  return buildPlanRouteTubePolylines({
    points: route.points,
    storeyId: route.storeyId,
    footprints,
    modelBounds,
    coordInverse,
  });
}

/**
 * INFER ⇄ BIM viewer integration boundary.
 *
 * Shell chrome (children overlays) stays in the product UI.
 * Geometry rendering uses the That Open / web-ifc runtime (same engine as the
 * temporary viewer), mounted into `viewerHostRef`.
 */
export interface InferModelViewportProps {
  modelId: string;
  selectedElementIds?: string[];
  highlightedRoute?: Route | null;
  hiddenStoreyIds?: string[];
  hazardZones?: HazardZone[];
  navigationStart?: string | null;
  navigationDestination?: string | null;
  animationStepIndex?: number;
  animationPlaying?: boolean;
  onElementSelected?: (elementId: string) => void;
  onPointSelected?: (point: { x: number; y: number; z: number }) => void;
  onViewerReady?: (host: HTMLDivElement) => void;
  className?: string;
  children?: React.ReactNode;
}

function InferModelViewportImpl({
  modelId,
  selectedElementIds = [],
  highlightedRoute = null,
  hiddenStoreyIds = [],
  hazardZones = [],
  navigationStart = null,
  navigationDestination = null,
  onViewerReady,
  className,
  children,
}: InferModelViewportProps) {
  const viewerHostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<ThatOpenRuntime | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [navMode, setNavMode] = useState<NavMode>("orbit");
  const [geometryMode, setGeometryMode] = useState<GeometryDisplayMode>("ifc");

  const {
    connectivityRoute,
    navmeshRoute,
    footprintsDocument,
    connectivityGraph,
    excludedNodeIds,
    excludedEdgeIds,
    entitiesExtract,
  } = useModelData();
  const {
    pendingIfc,
    setViewerStatus,
    // Shared with FloorplanViewer — picking a storey in either pane now
    // isolates the same floor in both, instead of two independent filters.
    activeStoreyId: viewerStoreyId,
    setActiveStoreyId: setViewerStoreyId,
  } = useViewport();
  const {
    setViewerCameraPose,
    setViewerModelBounds,
    setViewerCoordInverse,
    viewerCoordInverse,
    viewerModelBounds,
  } = useViewerPose();

  // Latest route inputs for post-load tube restore (avoid reloading IFC on route change).
  const tubeInputRef = useRef({
    connectivityRoute,
    navmeshRoute,
    footprintsDocument,
    connectivityGraph,
    viewerCoordInverse,
  });
  tubeInputRef.current = {
    connectivityRoute,
    navmeshRoute,
    footprintsDocument,
    connectivityGraph,
    viewerCoordInverse,
  };

  const switchNavMode = (mode: NavMode) => {
    setNavMode(mode);
    void runtimeRef.current?.setNavMode(mode);
  };

  const switchGeometryMode = (mode: GeometryDisplayMode) => {
    setGeometryMode(mode);
    runtimeRef.current?.setGeometryDisplayMode(mode);
  };

  const storeys = useMemo(() => {
    const fromFp = footprintsDocument?.storeys ?? [];
    if (fromFp.length) {
      return [...fromFp].sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
    }
    return (entitiesExtract?.storeys ?? []).map((s) => ({
      global_id: s.global_id,
      name: s.name,
      elevation: s.elevation ?? null,
    }));
  }, [footprintsDocument, entitiesExtract]);

  const viewerStoreyLabel = useMemo(() => {
    if (viewerStoreyId === "all") return "All levels";
    if (!storeys.length) return "No storeys";
    const match = storeys.find((s) => s.global_id === viewerStoreyId);
    if (!match) return "Select storey";
    return (
      match.name?.trim() ||
      (match.elevation != null ? `E${match.elevation}` : match.global_id.slice(0, 8))
    );
  }, [storeys, viewerStoreyId]);

  // Drop stale viewer storey when the model changes.
  useEffect(() => {
    if (viewerStoreyId === "all") return;
    if (storeys.some((s) => s.global_id === viewerStoreyId)) return;
    setViewerStoreyId("all");
  }, [storeys, viewerStoreyId]);

  // Isolate IFC geometry with a vertical clip band (reliable vs IFC containment).
  useEffect(() => {
    if (!engineReady || !runtimeRef.current) return;
    const runtime = runtimeRef.current;

    if (viewerStoreyId === "all") {
      void runtime.setStoreyFilter({ kind: "all" });
      return;
    }

    const bounds = runtime.getModelBounds() ?? viewerModelBounds;
    if (!bounds || !footprintsDocument) {
      void runtime.setStoreyFilter({ kind: "all" });
      return;
    }

    const raw = (footprintsDocument.storeys ?? []).filter(
      (s): s is { global_id: string; name: string; elevation: number } =>
        s.elevation != null && Number.isFinite(s.elevation),
    );
    if (!raw.length) {
      void runtime.setStoreyFilter({ kind: "all" });
      return;
    }

    const modelHeightM = bounds.maxY - bounds.minY;
    const { metres } = normalizeElevationsToMetres(
      raw.map((s) => s.elevation),
      modelHeightM,
    );
    const ranked = raw
      .map((s, i) => ({
        global_id: s.global_id,
        elevation: metres[i]!,
      }))
      .sort((a, b) => a.elevation - b.elevation);

    const idx = ranked.findIndex((s) => s.global_id === viewerStoreyId);
    if (idx < 0) {
      void runtime.setStoreyFilter({ kind: "all" });
      return;
    }

    const elev = ranked[idx]!.elevation;
    const nextElev =
      idx + 1 < ranked.length ? ranked[idx + 1]!.elevation : elev + 3.5;
    const storeyHeight = Math.max(nextElev - elev, 1.5);
    // Keep the floor; cut well below the next storey so the ceiling / upper
    // slab is gone when looking down (open-top floor plate).
    const minElevM = elev - 0.25;
    const maxElevM = elev + storeyHeight * 0.78;

    const spaceIds = footprintsDocument.spaces
      .filter((s) => !s.incomplete && s.storey_global_id)
      .map((s) => s.storey_global_id!);
    const storeyElevationsM = elevationsForVerticalRemap(
      ranked.map((s) => ({ global_id: s.global_id, elevation: s.elevation })),
      spaceIds,
    );

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of footprintsDocument.spaces) {
      if (s.incomplete) continue;
      for (const p of s.polygon) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    if (!Number.isFinite(minX)) {
      void runtime.setStoreyFilter({ kind: "all" });
      return;
    }

    const liftOpts = resolveRouteTubeLiftOptions({
      planBounds: { minX, maxX, minY, maxY },
      probeElevationM: storeyElevationsM.length
        ? Math.min(...storeyElevationsM)
        : elev,
      modelBounds: bounds,
      storeyElevationsM,
      coordInverse: runtime.getCoordinationInverse() ?? viewerCoordInverse,
    });
    // No height offset — clip against true storey elevations.
    liftOpts.heightOffsetM = 0;

    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const lo = ifcPlanToThree(midX, midY, minElevM, liftOpts);
    const hi = ifcPlanToThree(midX, midY, maxElevM, liftOpts);
    const filter: StoreyFilter = {
      kind: "band",
      minY: Math.min(lo.y, hi.y),
      maxY: Math.max(lo.y, hi.y),
    };
    void runtime.setStoreyFilter(filter);
  }, [
    engineReady,
    viewerStoreyId,
    pendingIfc,
    footprintsDocument,
    viewerModelBounds,
    viewerCoordInverse,
  ]);

  // Boot That Open once the host is mounted (client-only).
  useEffect(() => {
    const host = viewerHostRef.current;
    if (!host) return;

    let disposed = false;
    onViewerReady?.(host);

    void (async () => {
      try {
        const runtime = await createThatOpenRuntime(
          host,
          (message, kind) => {
            if (!disposed) setViewerStatus(message, kind ?? "info");
          },
          (pose) => {
            if (!disposed) setViewerCameraPose(pose);
          },
          (bounds) => {
            if (!disposed) setViewerModelBounds(bounds);
          },
          (inv) => {
            if (!disposed) setViewerCoordInverse(inv);
          },
        );
        if (disposed) {
          runtime.dispose();
          return;
        }
        runtimeRef.current = runtime;
        setEngineReady(true);
        setEngineError(null);
        setNavMode(runtime.getNavMode());
        setViewerCameraPose(runtime.getCameraPose());
        setViewerModelBounds(runtime.getModelBounds());
        setViewerCoordInverse(runtime.getCoordinationInverse());
      } catch (error) {
        console.error(error);
        if (!disposed) {
          const message =
            error instanceof Error ? error.message : "Failed to init 3D viewer";
          setEngineError(message);
          setViewerStatus(message, "error");
        }
      }
    })();

    return () => {
      disposed = true;
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
      setEngineReady(false);
      setViewerCameraPose(null);
      setViewerModelBounds(null);
      setViewerCoordInverse(null);
    };
  }, [
    modelId,
    onViewerReady,
    setViewerStatus,
    setViewerCameraPose,
    setViewerModelBounds,
    setViewerCoordInverse,
  ]);

  // Load / reload IFC retained in the store. Closing the 3D pane disposes the
  // WebGL runtime; reopening must rehydrate from this buffer (do not clear it).
  useEffect(() => {
    if (!pendingIfc || !engineReady || !runtimeRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        // Pass a copy so the store buffer stays intact for the floorplan pane.
        await runtimeRef.current?.loadBuffer(
          pendingIfc.buffer.slice(),
          pendingIfc.name,
        );
        if (cancelled) return;
        setNavMode("orbit");
        // loadBuffer clears meshes; restore tube using post-load bounds/matrix.
        const rt = runtimeRef.current;
        if (!rt) return;
        const input = tubeInputRef.current;
        const navTube = buildNavmeshRouteTube(
          input.navmeshRoute,
          input.footprintsDocument,
          rt.getModelBounds(),
          rt.getCoordinationInverse() ?? input.viewerCoordInverse,
        );
        const polylines =
          navTube ??
          buildRouteTubePolylines({
            route: input.connectivityRoute,
            footprints: input.footprintsDocument,
            graph: input.connectivityGraph,
            modelBounds: rt.getModelBounds(),
            coordInverse:
              rt.getCoordinationInverse() ?? input.viewerCoordInverse,
          });
        rt.setRouteTube(polylines);
      } catch (error) {
        if (!cancelled) {
          setViewerStatus(
            error instanceof Error ? error.message : "Failed to load IFC",
            "error",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingIfc, engineReady, setViewerStatus]);

  // Click-to-click navmesh path (preferred) or legacy graph route → blue tube.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!engineReady || !runtime) return;
    // Prefer live runtime bounds/matrix — React state can lag after load.
    const bounds = runtime.getModelBounds() ?? viewerModelBounds;
    const coordInverse =
      runtime.getCoordinationInverse() ?? viewerCoordInverse;
    const navTube = buildNavmeshRouteTube(navmeshRoute, footprintsDocument, bounds, coordInverse);
    const polylines =
      navTube ??
      buildRouteTubePolylines({
        route: connectivityRoute,
        footprints: footprintsDocument,
        graph: connectivityGraph,
        modelBounds: bounds,
        coordInverse,
      });
    runtime.setRouteTube(polylines);
  }, [
    engineReady,
    navmeshRoute,
    connectivityRoute,
    footprintsDocument,
    connectivityGraph,
    viewerModelBounds,
    viewerCoordInverse,
  ]);

  // Portal navmeshes — all storeys stacked, or one level when isolated.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!engineReady || !runtime) return;

    if (geometryMode !== "navmesh") {
      runtime.setNavmesh(null);
      return;
    }

    if (!footprintsDocument || !connectivityGraph) {
      runtime.setNavmesh(null);
      return;
    }

    const bounds = runtime.getModelBounds() ?? viewerModelBounds;
    if (!bounds) {
      runtime.setNavmesh(null);
      return;
    }

    const opts = { excludedNodeIds, excludedEdgeIds };
    const meshes =
      viewerStoreyId === "all"
        ? buildAllStoreyNavmeshes(footprintsDocument, connectivityGraph, opts)
        : (() => {
            const one = buildStoreyNavmesh(
              footprintsDocument,
              connectivityGraph,
              viewerStoreyId,
              opts,
            );
            return one.regions.length ? [one] : [];
          })();
    if (!meshes.length) {
      runtime.setNavmesh(null);
      return;
    }

    const raw = (footprintsDocument.storeys ?? []).filter(
      (s): s is { global_id: string; name: string; elevation: number } =>
        s.elevation != null && Number.isFinite(s.elevation),
    );
    const modelHeightM = bounds.maxY - bounds.minY;
    const { metres } = normalizeElevationsToMetres(
      raw.map((s) => s.elevation),
      modelHeightM,
    );
    const storeysM = raw.map((s, i) => ({
      global_id: s.global_id,
      elevation: metres[i]!,
    }));
    const spaceIds = footprintsDocument.spaces
      .filter((s) => !s.incomplete && s.storey_global_id)
      .map((s) => s.storey_global_id!);
    const storeyElevationsM = elevationsForVerticalRemap(storeysM, spaceIds);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const mesh of meshes) {
      for (const r of mesh.regions) {
        for (const p of r.polygon) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
      }
    }
    if (!Number.isFinite(minX)) {
      runtime.setNavmesh(null);
      return;
    }

    const liftOpts = {
      ...resolveRouteTubeLiftOptions({
        planBounds: { minX, maxX, minY, maxY },
        probeElevationM: storeyElevationsM.length
          ? Math.min(...storeyElevationsM)
          : storeysM.length
            ? Math.min(...storeysM.map((s) => s.elevation))
            : 0,
        modelBounds: bounds,
        storeyElevationsM,
        coordInverse: runtime.getCoordinationInverse() ?? viewerCoordInverse,
      }),
      heightOffsetM: NAVMESH_HEIGHT_OFFSET_M,
    };

    const regions: Array<{
      id: string;
      vertices: Array<{ x: number; y: number; z: number }>;
      holes: Array<Array<{ x: number; y: number; z: number }>>;
    }> = [];
    const portals: Array<{
      id: string;
      kind: "door" | "space";
      inferred?: boolean;
      point: { x: number; y: number; z: number };
    }> = [];
    for (const mesh of meshes) {
      const elevation =
        storeysM.find((s) => s.global_id === mesh.storeyId)?.elevation ?? 0;
      for (const r of mesh.regions) {
        regions.push({
          id: `${mesh.storeyId}:${r.spaceId}`,
          vertices: liftPlanPolylineToThree(r.polygon, elevation, liftOpts),
          holes: r.holes.map((h) => liftPlanPolylineToThree(h, elevation, liftOpts)),
        });
      }
      for (const p of mesh.portals) {
        const point = liftPlanPolylineToThree([p.point], elevation, liftOpts)[0];
        if (!point) continue;
        portals.push({
          id: `${mesh.storeyId}:${p.id}`,
          // The 3D overlay (that-open-runtime.ts) only distinguishes door vs
          // space portals; render exit portals as doors there rather than
          // touching that renderer's portal-kind type.
          kind: p.kind === "exit" ? "door" : p.kind,
          inferred: p.inferred,
          point,
        });
      }
    }

    runtime.setNavmesh({ regions, portals });
  }, [
    engineReady,
    geometryMode,
    viewerStoreyId,
    footprintsDocument,
    connectivityGraph,
    excludedNodeIds,
    excludedEdgeIds,
    viewerModelBounds,
    viewerCoordInverse,
  ]);

  // Keep route/hazard props available for future overlays (not drawn by placeholder).
  void highlightedRoute;
  void hazardZones;
  void selectedElementIds;

  return (
    <div
      className={cn("relative isolate h-full w-full overflow-hidden bg-viewport", className)}
      data-model-id={modelId}
      data-active-storey={viewerStoreyId}
      data-hidden-storeys={hiddenStoreyIds.join(",")}
      data-selected={selectedElementIds.join(",")}
      data-navigation-start={navigationStart ?? ""}
      data-navigation-destination={navigationDestination ?? ""}
    >
      <div
        ref={viewerHostRef}
        role="application"
        aria-label={`Three-dimensional building model viewport for ${modelId}`}
        tabIndex={0}
        className="viewport-dark absolute inset-0 outline-none"
      />

      {engineReady && !engineError && (
        <div className="pointer-events-auto absolute left-3 top-3 z-20 flex flex-col items-start gap-1.5">
          <div className={cn(GLASS, "flex overflow-hidden")}>
            <button
              type="button"
              onClick={() => switchNavMode("orbit")}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] transition-colors",
                navMode === "orbit"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              title="Orbit camera"
            >
              <Move3d className="size-3.5" aria-hidden />
              Orbit
            </button>
            <button
              type="button"
              onClick={() => switchNavMode("fly")}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] transition-colors",
                navMode === "fly"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              title="First-person fly (WASD, Space, Shift)"
            >
              <PersonStanding className="size-3.5" aria-hidden />
              Fly
            </button>
          </div>

          <div className={cn(GLASS, "flex overflow-hidden")}>
            <button
              type="button"
              onClick={() => switchGeometryMode("ifc")}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] transition-colors",
                geometryMode === "ifc"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              title="Show IFC geometry"
            >
              <Box className="size-3.5" aria-hidden />
              IFC Geometry
            </button>
            <button
              type="button"
              onClick={() => switchGeometryMode("navmesh")}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] transition-colors",
                geometryMode === "navmesh"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              title="Show portal navmesh (all levels or the selected storey)"
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
                title="Storey — shared with the Floorplan pane; pick All levels to see every floor in 3D"
              >
                <span className="min-w-0 truncate">{viewerStoreyLabel}</span>
                <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 min-w-[10rem] overflow-y-auto">
              <DropdownMenuItem
                className="text-[12px]"
                onSelect={() => setViewerStoreyId("all")}
              >
                {viewerStoreyId === "all" ? (
                  <Check className="size-3.5" />
                ) : (
                  <span className="size-3.5" />
                )}
                All levels
              </DropdownMenuItem>
              {storeys.map((s) => {
                const label =
                  s.name?.trim() ||
                  (s.elevation != null ? `E${s.elevation}` : s.global_id.slice(0, 8));
                const active = viewerStoreyId === s.global_id;
                return (
                  <DropdownMenuItem
                    key={s.global_id}
                    className="text-[12px]"
                    onSelect={() => setViewerStoreyId(s.global_id)}
                  >
                    {active ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                    {label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {engineReady && !engineError && navMode === "fly" && (
        <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/80 bg-background/90 px-2 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
          <span>
            <span className="font-medium text-foreground">WASD</span> move
          </span>
          <span>
            <span className="font-medium text-foreground">Space</span> up
          </span>
          <span>
            <span className="font-medium text-foreground">Shift</span> down
          </span>
          <span>
            <span className="font-medium text-foreground">Ctrl</span> faster
          </span>
          <span>drag to look</span>
        </div>
      )}

      {!engineReady && !engineError && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-[13px] text-muted-foreground">
          Starting 3D viewer…
        </div>
      )}
      {engineError && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-[13px] text-destructive">
          {engineError}
        </div>
      )}

      {/* Overlay chrome (toolbar, storey selector, layers) */}
      {children}
    </div>
  );
}

export const InferModelViewport = memo(InferModelViewportImpl);
