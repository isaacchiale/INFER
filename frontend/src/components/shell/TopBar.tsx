import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useInfer, useModelData, useViewport } from "@/state/infer-store";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "@/lib/utils";

export function TopBar() {
  const { setIngestOpen, viewerStatus, viewerStatusKind, pendingIfc } = useInfer();
  const { footprintsDocument, connectivityGraph } = useModelData();
  const { controlPanelOpen, setControlPanelOpen } = useViewport();
  const modelName =
    pendingIfc?.name.replace(/\.(ifc|ifczip|gml|indoorgml)$/i, "") || "No model loaded";
  const hasModel = Boolean(footprintsDocument || connectivityGraph);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-3">
      <span className="text-[13px] font-semibold tracking-[0.14em] text-foreground">INFER</span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1 rounded-[5px] px-1.5 py-1 text-[13px] text-foreground transition-colors hover:bg-muted">
            {modelName}
            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem className="text-[13px]">
            <Check className="size-3.5" /> {modelName}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-[13px]" onSelect={() => setIngestOpen(true)}>
            Open model…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <p
        className={
          viewerStatusKind === "error"
            ? "hidden min-w-0 flex-1 truncate text-[12px] text-destructive sm:block"
            : viewerStatusKind === "loading"
              ? "hidden min-w-0 flex-1 truncate text-[12px] text-amber-600 dark:text-amber-400 sm:block"
              : "hidden min-w-0 flex-1 truncate text-[12px] text-muted-foreground sm:block"
        }
        title={viewerStatus}
      >
        {viewerStatus}
      </p>

      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          disabled={!hasModel}
          aria-pressed={controlPanelOpen}
          onClick={() => setControlPanelOpen(!controlPanelOpen)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2 text-[12px] font-medium transition-colors disabled:opacity-40",
            controlPanelOpen
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          title={controlPanelOpen ? "Minimize control panel" : "Expand control panel"}
        >
          <SlidersHorizontal className="size-3.5" aria-hidden />
          Control
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}
