import { useRef, useState, type ReactNode } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { Box, GitFork, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { GraphViewer } from "@/components/graph/GraphViewer";

function PaneChrome({
  title,
  icon,
  collapsed,
  onToggle,
  children,
  className,
}: {
  title: string;
  icon: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {icon}
          <span>{title}</span>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={collapsed ? `Expand ${title}` : `Minimise ${title}`}
          title={collapsed ? `Expand ${title}` : `Minimise ${title}`}
        >
          {collapsed ? <Maximize2 className="size-3.5" /> : <Minimize2 className="size-3.5" />}
        </button>
      </div>
      <div className={cn("min-h-0 flex-1", collapsed && "hidden")}>{children}</div>
    </div>
  );
}

export function SplitWorkspace({ modelPane }: { modelPane: ReactNode }) {
  const leftRef = useRef<ImperativePanelHandle>(null);
  const rightRef = useRef<ImperativePanelHandle>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const toggleLeft = () => {
    const panel = leftRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
      setLeftCollapsed(false);
    } else {
      // If the other side is already collapsed, expand it first so one pane remains.
      if (rightRef.current?.isCollapsed()) {
        rightRef.current.expand();
        setRightCollapsed(false);
      }
      panel.collapse();
      setLeftCollapsed(true);
    }
  };

  const toggleRight = () => {
    const panel = rightRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
      setRightCollapsed(false);
    } else {
      if (leftRef.current?.isCollapsed()) {
        leftRef.current.expand();
        setLeftCollapsed(false);
      }
      panel.collapse();
      setRightCollapsed(true);
    }
  };

  return (
    <PanelGroup direction="horizontal" className="min-h-0 flex-1" autoSaveId="infer-split-workspace">
      <Panel
        ref={leftRef}
        defaultSize={55}
        minSize={18}
        collapsible
        collapsedSize={3}
        onCollapse={() => setLeftCollapsed(true)}
        onExpand={() => setLeftCollapsed(false)}
        className="min-w-0"
      >
        <PaneChrome
          title="3D Viewer"
          icon={<Box className="size-3.5" />}
          collapsed={leftCollapsed}
          onToggle={toggleLeft}
        >
          <div className="relative h-full min-h-0">{modelPane}</div>
        </PaneChrome>
      </Panel>

      <PanelResizeHandle
        className={cn(
          "group relative w-1.5 bg-border transition-colors",
          "hover:bg-primary/50 data-[resize-handle-active]:bg-primary",
        )}
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-primary/60" />
      </PanelResizeHandle>

      <Panel
        ref={rightRef}
        defaultSize={45}
        minSize={18}
        collapsible
        collapsedSize={3}
        onCollapse={() => setRightCollapsed(true)}
        onExpand={() => setRightCollapsed(false)}
        className="min-w-0"
      >
        <PaneChrome
          title="Graph Viewer"
          icon={<GitFork className="size-3.5" />}
          collapsed={rightCollapsed}
          onToggle={toggleRight}
        >
          <div className="relative h-full min-h-0">
            <GraphViewer className="h-full" />
          </div>
        </PaneChrome>
      </Panel>
    </PanelGroup>
  );
}
