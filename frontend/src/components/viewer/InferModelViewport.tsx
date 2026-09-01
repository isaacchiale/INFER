import { memo, useEffect, useRef, useState } from "react";
import { Move3d, PersonStanding } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HazardZone, Route } from "@/types/infer";
import { useInfer } from "@/state/infer-store";
import {
  createThatOpenRuntime,
  type NavMode,
  type ThatOpenRuntime,
} from "@/viewer/that-open-runtime";

const GLASS =
  "rounded-[6px] border border-border bg-background/90 shadow-sm backdrop-blur-[2px]";

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
  activeStoreyId?: string | "all";
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
  activeStoreyId = "all",
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

  const {
    pendingIfc,
    setViewerStatus,
    setViewerCameraPose,
    setViewerModelBounds,
    setViewerCoordInverse,
  } = useInfer();

  const switchNavMode = (mode: NavMode) => {
    setNavMode(mode);
    void runtimeRef.current?.setNavMode(mode);
  };

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
        await runtimeRef.current?.loadBuffer(pendingIfc.buffer.slice(), pendingIfc.name);
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

  // Keep route/hazard props available for future overlays (not drawn by placeholder).
  void highlightedRoute;
  void hazardZones;
  void selectedElementIds;

  return (
    <div
      className={cn("relative isolate h-full w-full overflow-hidden bg-viewport", className)}
      data-model-id={modelId}
      data-active-storey={activeStoreyId}
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
        <div className={cn(GLASS, "pointer-events-auto absolute left-3 top-3 z-20 flex overflow-hidden")}>
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
