import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { Box, GitFork, LayoutGrid, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { GraphViewer } from "@/components/graph/GraphViewer";
import { FloorplanViewer } from "@/components/floorplan/FloorplanViewer";

export type PaneId = "model3d" | "floorplan" | "graph";

type PaneState = {
  open: boolean;
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

clearPersistedPaneLayout();

/** Stable off-screen size so WebGL / Cytoscape keep a real framebuffer while parked. */
const KEEP_ALIVE = { width: 640, height: 480 };

function equalDefaultSize(openCount: number): number {
  return openCount > 0 ? 100 / openCount : 100;
}

function PaneChrome({
  title,
  icon,
  onClose,
  children,
}: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {icon}
          <span>{title}</span>
        </div>
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

function parkHost(host: HTMLElement, workspace: HTMLElement) {
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
}

function dockHost(host: HTMLElement, target: HTMLElement) {
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
}

const PARKED_STYLE: CSSProperties = {
  position: "fixed",
  left: -10000,
  top: 0,
  width: KEEP_ALIVE.width,
  height: KEEP_ALIVE.height,
  opacity: 0,
  pointerEvents: "none",
};

export function SplitWorkspace({ modelPane }: { modelPane: ReactNode }) {
  const [panes, setPanes] = useState<Record<PaneId, PaneState>>({
    model3d: { open: true },
    floorplan: { open: true },
    graph: { open: true },
  });

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const threeSlotRef = useRef<HTMLDivElement | null>(null);
  const floorSlotRef = useRef<HTMLDivElement | null>(null);
  const graphSlotRef = useRef<HTMLDivElement | null>(null);
  const threeHostRef = useRef<HTMLDivElement | null>(null);
  const floorHostRef = useRef<HTMLDivElement | null>(null);
  const graphHostRef = useRef<HTMLDivElement | null>(null);

  const openCount = (Object.keys(panes) as PaneId[]).filter((id) => panes[id].open).length;

  const closePane = useCallback((id: PaneId) => {
    setPanes((prev) => {
      const othersOpen = (Object.keys(prev) as PaneId[]).filter((k) => k !== id && prev[k].open);
      if (othersOpen.length === 0) return prev;
      return {
        ...prev,
        [id]: { open: false },
      };
    });
  }, []);

  const openPane = useCallback((id: PaneId) => {
    setPanes((prev) => ({
      ...prev,
      [id]: { open: true },
    }));
  }, []);

  const defaultSize = equalDefaultSize(openCount);

  /**
   * Keep a single mount per viewer (3D / floorplan / graph). Closed panes park
   * off-screen so WebGL / Cytoscape stay alive; open panes dock into slots.
   */
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const threeHost = threeHostRef.current;
    const floorHost = floorHostRef.current;
    const graphHost = graphHostRef.current;
    if (!workspace || !threeHost || !floorHost || !graphHost) return;

    const sync = () => {
      if (panes.model3d.open && threeSlotRef.current) {
        dockHost(threeHost, threeSlotRef.current);
      } else {
        parkHost(threeHost, workspace);
      }

      if (panes.floorplan.open && floorSlotRef.current) {
        dockHost(floorHost, floorSlotRef.current);
      } else {
        parkHost(floorHost, workspace);
      }

      if (panes.graph.open && graphSlotRef.current) {
        dockHost(graphHost, graphSlotRef.current);
      } else {
        parkHost(graphHost, workspace);
      }
    };

    sync();

    const ro = new ResizeObserver(() => sync());
    ro.observe(workspace);
    if (threeSlotRef.current) ro.observe(threeSlotRef.current);
    if (floorSlotRef.current) ro.observe(floorSlotRef.current);
    if (graphSlotRef.current) ro.observe(graphSlotRef.current);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [panes.model3d.open, panes.floorplan.open, panes.graph.open]);

  const show3d = panes.model3d.open;
  const showFloor = panes.floorplan.open;
  const showGraph = panes.graph.open;

  const modelOrder = 1;
  const floorOrder = show3d ? 2 : 1;
  const graphOrder = 1 + Number(show3d) + Number(showFloor);

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
                <div
                  ref={threeSlotRef}
                  className="relative h-full w-full overflow-hidden bg-viewport"
                />
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
                <div ref={floorSlotRef} className="relative h-full w-full overflow-hidden" />
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
              <div ref={graphSlotRef} className="relative h-full w-full overflow-hidden" />
            </Panel>
          )}

          {openCount === 0 && <div ref={threeSlotRef} className="h-full w-full" />}
        </PanelGroup>

        {/* Keep-alive hosts — never unmounted while the workspace lives */}
        <div
          ref={threeHostRef}
          className="overflow-hidden bg-background shadow-sm"
          style={PARKED_STYLE}
        >
          <PaneChrome
            title={PANE_META.model3d.title}
            icon={PANE_META.model3d.icon}
            onClose={() => closePane("model3d")}
          >
            <div className="relative h-full min-h-0">{modelPane}</div>
          </PaneChrome>
        </div>

        <div
          ref={floorHostRef}
          className="overflow-hidden bg-background shadow-sm"
          style={PARKED_STYLE}
        >
          <PaneChrome
            title={PANE_META.floorplan.title}
            icon={PANE_META.floorplan.icon}
            onClose={() => closePane("floorplan")}
          >
            <FloorplanViewer className="h-full" />
          </PaneChrome>
        </div>

        <div
          ref={graphHostRef}
          className="overflow-hidden bg-background shadow-sm"
          style={PARKED_STYLE}
        >
          <PaneChrome
            title={PANE_META.graph.title}
            icon={PANE_META.graph.icon}
            onClose={() => closePane("graph")}
          >
            <GraphViewer className="h-full" />
          </PaneChrome>
        </div>
      </div>
    </div>
  );
}
