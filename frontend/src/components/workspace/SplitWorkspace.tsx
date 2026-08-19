import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { Box, GitFork, LayoutGrid, Maximize2, Minimize2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { GraphViewer } from "@/components/graph/GraphViewer";
import { FloorplanViewer } from "@/components/floorplan/FloorplanViewer";

export type PaneId = "model3d" | "floorplan" | "graph";

type PaneState = {
  open: boolean;
  maximized: boolean;
};

const PANE_META: Record<PaneId, { title: string; icon: ReactNode }> = {
  model3d: { title: "3D Viewer", icon: <Box className="size-3.5" /> },
  floorplan: { title: "Floorplan Viewer", icon: <LayoutGrid className="size-3.5" /> },
  graph: { title: "Graph Viewer", icon: <GitFork className="size-3.5" /> },
};

/** Wipe prior session panel sizes so a full reload always starts equal thirds. */
function clearPersistedPaneLayout() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        (key.startsWith("react-resizable-panels:") || key.includes("infer-workspace"))
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// Drop any prior session panel layout before the first paint (reload = equal thirds).
clearPersistedPaneLayout();

/** Stable off-screen size so WebGL keeps a real framebuffer while the pane is closed. */
const KEEP_ALIVE = { width: 640, height: 480 };

function equalDefaultSize(openCount: number): number {
  return openCount > 0 ? 100 / openCount : 100;
}

function PaneChrome({
  title,
  icon,
  onClose,
  onMaximize,
  maximized,
  children,
}: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  onMaximize: () => void;
  maximized: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {icon}
          <span>{title}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onMaximize}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={maximized ? `Restore ${title}` : `Maximize ${title}`}
            title={maximized ? `Restore ${title}` : `Maximize ${title}`}
          >
            {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={`Close ${title}`}
            title={`Close ${title}`}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function ResizeHandle() {
  return (
    <PanelResizeHandle
      className={cn(
        "group relative w-1.5 bg-border transition-colors",
        "hover:bg-primary/50 data-[resize-handle-active]:bg-primary",
      )}
    />
  );
}

export function SplitWorkspace({ modelPane }: { modelPane: ReactNode }) {
  const [panes, setPanes] = useState<Record<PaneId, PaneState>>({
    model3d: { open: true, maximized: false },
    floorplan: { open: true, maximized: false },
    graph: { open: true, maximized: false },
  });

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const threeSlotRef = useRef<HTMLDivElement | null>(null);
  const threeHostRef = useRef<HTMLDivElement | null>(null);

  const openCount = (Object.keys(panes) as PaneId[]).filter((id) => panes[id].open).length;
  const maximizedId = (Object.keys(panes) as PaneId[]).find(
    (id) => panes[id].maximized && panes[id].open,
  );

  /** 3D should be visible in the layout (not parked). */
  const threeDocked =
    panes.model3d.open && (maximizedId == null || maximizedId === "model3d");

  const closePane = useCallback((id: PaneId) => {
    setPanes((prev) => {
      const othersOpen = (Object.keys(prev) as PaneId[]).filter((k) => k !== id && prev[k].open);
      if (othersOpen.length === 0) return prev;
      return {
        ...prev,
        [id]: { open: false, maximized: false },
        ...Object.fromEntries(othersOpen.map((k) => [k, { ...prev[k], maximized: false }])),
      } as Record<PaneId, PaneState>;
    });
  }, []);

  const openPane = useCallback((id: PaneId) => {
    setPanes((prev) => ({
      ...prev,
      [id]: { open: true, maximized: false },
    }));
  }, []);

  const toggleMaximize = useCallback((id: PaneId) => {
    setPanes((prev) => {
      const willMax = !prev[id].maximized;
      const next = { ...prev };
      (Object.keys(next) as PaneId[]).forEach((k) => {
        next[k] = {
          open: prev[k].open,
          maximized: willMax ? k === id : false,
        };
      });
      return next;
    });
  }, []);

  const chrome = (id: Exclude<PaneId, "model3d">) => (
    <PaneChrome
      title={PANE_META[id].title}
      icon={PANE_META[id].icon}
      maximized={!!panes[id].maximized}
      onClose={() => closePane(id)}
      onMaximize={() => toggleMaximize(id)}
    >
      {id === "floorplan" ? (
        <FloorplanViewer className="h-full" />
      ) : (
        <GraphViewer className="h-full" />
      )}
    </PaneChrome>
  );

  const defaultSize = equalDefaultSize(openCount);

  const mainLayout = () => {
    const show3d = panes.model3d.open;
    const showFloor = panes.floorplan.open;
    const showGraph = panes.graph.open;

    const modelOrder = 1;
    const floorOrder = show3d ? 2 : 1;
    const graphOrder = 1 + Number(show3d) + Number(showFloor);

    return (
      <PanelGroup direction="horizontal" className="h-full min-h-0">
        {show3d && (
          <>
            <Panel
              id="model3d"
              order={modelOrder}
              defaultSize={defaultSize}
              minSize={16}
              className="min-w-0"
            >
              <div ref={threeSlotRef} className="relative h-full w-full overflow-hidden bg-viewport" />
            </Panel>
            {(showFloor || showGraph) && <ResizeHandle />}
          </>
        )}

        {showFloor && (
          <>
            <Panel
              id="floorplan"
              order={floorOrder}
              defaultSize={defaultSize}
              minSize={16}
              className="min-w-0"
            >
              {chrome("floorplan")}
            </Panel>
            {showGraph && <ResizeHandle />}
          </>
        )}

        {showGraph && (
          <Panel
            id="graph"
            order={graphOrder}
            defaultSize={defaultSize}
            minSize={16}
            className="min-w-0"
          >
            {chrome("graph")}
          </Panel>
        )}

        {openCount === 0 && <div ref={threeSlotRef} className="h-full w-full" />}
      </PanelGroup>
    );
  };

  // Keep a single 3D mount: reparent into the slot (or workspace when maximized).
  // Never absolute-overlay the whole workspace at z-30 — a stale rect steals
  // wheel/pan from the graph/floorplan panes until maximize "fixes" it.
  useLayoutEffect(() => {
    const host = threeHostRef.current;
    const workspace = workspaceRef.current;
    if (!host || !workspace) return;

    const park = () => {
      if (host.parentElement !== workspace) {
        workspace.appendChild(host);
      }
      host.style.position = "fixed";
      host.style.left = "-10000px";
      host.style.top = "0px";
      host.style.right = "auto";
      host.style.bottom = "auto";
      host.style.width = `${KEEP_ALIVE.width}px`;
      host.style.height = `${KEEP_ALIVE.height}px`;
      host.style.opacity = "0";
      host.style.pointerEvents = "none";
      host.style.zIndex = "-1";
      host.setAttribute("aria-hidden", "true");
    };

    const dockInto = (target: HTMLElement) => {
      if (getComputedStyle(target).position === "static") {
        target.style.position = "relative";
      }
      if (host.parentElement !== target) {
        target.appendChild(host);
      }
      host.style.position = "absolute";
      host.style.left = "0";
      host.style.top = "0";
      host.style.right = "0";
      host.style.bottom = "0";
      host.style.width = "100%";
      host.style.height = "100%";
      host.style.opacity = "1";
      host.style.pointerEvents = "auto";
      host.style.zIndex = "1";
      host.setAttribute("aria-hidden", "false");
    };

    const sync = () => {
      if (maximizedId === "model3d") {
        dockInto(workspace);
        return;
      }
      if (threeDocked && threeSlotRef.current) {
        dockInto(threeSlotRef.current);
        return;
      }
      park();
    };

    sync();

    const ro = new ResizeObserver(() => sync());
    ro.observe(workspace);
    if (threeSlotRef.current) ro.observe(threeSlotRef.current);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [threeDocked, maximizedId, panes.model3d.open, panes.floorplan.open, panes.graph.open]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-surface-raised px-2">
        <span className="mr-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Panes
        </span>
        {(Object.keys(PANE_META) as PaneId[]).map((id) => {
          const active = panes[id].open;
          return (
            <button
              key={id}
              type="button"
              onClick={() => (active ? closePane(id) : openPane(id))}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              title={active ? `Close ${PANE_META[id].title}` : `Open ${PANE_META[id].title}`}
            >
              {PANE_META[id].icon}
              {PANE_META[id].title}
            </button>
          );
        })}
      </div>

      <div ref={workspaceRef} className="relative min-h-0 flex-1 overflow-hidden">
        {maximizedId && maximizedId !== "model3d"
          ? chrome(maximizedId)
          : maximizedId === "model3d"
            ? null
            : mainLayout()}

        {/* Single keep-alive 3D host — never unmounted while the workspace lives */}
        <div
          ref={threeHostRef}
          className="overflow-hidden bg-background shadow-sm"
          // Initial park until layout effect runs
          style={{
            position: "fixed",
            left: -10000,
            top: 0,
            width: KEEP_ALIVE.width,
            height: KEEP_ALIVE.height,
            opacity: 0,
            pointerEvents: "none",
          }}
        >
          <PaneChrome
            title={PANE_META.model3d.title}
            icon={PANE_META.model3d.icon}
            maximized={maximizedId === "model3d"}
            onClose={() => closePane("model3d")}
            onMaximize={() => toggleMaximize("model3d")}
          >
            <div className="relative h-full min-h-0">{modelPane}</div>
          </PaneChrome>
        </div>
      </div>
    </div>
  );
}
