import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useInfer } from "@/state/infer-store";
import { ThemeToggle } from "./ThemeToggle";

export function TopBar() {
  const { setIngestOpen, viewerStatus, viewerStatusKind, pendingIfc } = useInfer();
  const modelName = pendingIfc?.name.replace(/\.ifc$/i, "") || "No model loaded";

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
        <ThemeToggle />
      </div>
    </header>
  );
}
