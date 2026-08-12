import { memo, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { HazardZone, Route } from "@/types/infer";
import { useInfer } from "@/state/infer-store";
import {
  createThatOpenRuntime,
  type ThatOpenRuntime,
} from "@/viewer/that-open-runtime";

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

  const { pendingIfc, clearPendingIfc, setViewerStatus } = useInfer();

  // Boot That Open once the host is mounted (client-only).
  useEffect(() => {
    const host = viewerHostRef.current;
    if (!host) return;

    let disposed = false;
    onViewerReady?.(host);

    void (async () => {
      try {
        const runtime = await createThatOpenRuntime(host, (message, kind) => {
          if (!disposed) setViewerStatus(message, kind ?? "info");
        });
        if (disposed) {
          runtime.dispose();
          return;
        }
        runtimeRef.current = runtime;
        setEngineReady(true);
        setEngineError(null);
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
    };
  }, [modelId, onViewerReady, setViewerStatus]);

  // Load IFC queued by IngestDialog (or future backend bridge).
  useEffect(() => {
    if (!pendingIfc || !engineReady || !runtimeRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        await runtimeRef.current?.loadBuffer(pendingIfc.buffer, pendingIfc.name);
      } catch (error) {
        if (!cancelled) {
          setViewerStatus(
            error instanceof Error ? error.message : "Failed to load IFC",
            "error",
          );
        }
      } finally {
        if (!cancelled) clearPendingIfc();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingIfc, engineReady, clearPendingIfc, setViewerStatus]);

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
