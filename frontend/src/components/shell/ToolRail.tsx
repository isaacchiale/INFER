import { Box, Layers, Navigation, ShieldCheck, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useInfer, type WorkMode } from "@/state/infer-store";

const tools: { id: WorkMode; label: string; icon: typeof Box }[] = [
  { id: "model", label: "Model", icon: Box },
  { id: "navigate", label: "Navigate", icon: Navigation },
  { id: "layers", label: "Layers", icon: Layers },
  { id: "validate", label: "Validate", icon: ShieldCheck },
  { id: "scenario", label: "Scenarios", icon: TriangleAlert },
];

export function ToolRail() {
  const { workMode, setWorkMode } = useInfer();

  return (
    <nav aria-label="Workspace tools" className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-background py-2">
      {tools.map((t) => {
        const active = workMode === t.id;
        return (
          <Tooltip key={t.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => setWorkMode(t.id)}
                className={cn(
                  "grid size-8 place-items-center rounded-[5px] text-muted-foreground transition-colors duration-150",
                  "hover:bg-muted hover:text-foreground",
                  active && "bg-accent text-accent-foreground",
                )}
              >
                <t.icon aria-hidden className="size-4" />
                <span className="sr-only">{t.label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{t.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
