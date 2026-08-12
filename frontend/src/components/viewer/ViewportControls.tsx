import { Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { storeys } from "@/data/mock";
import { cn } from "@/lib/utils";
import { useInfer } from "@/state/infer-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function FloorSelector() {
  const { activeStoreyId, setActiveStoreyId } = useInfer();

  return (
    <div className="pointer-events-auto absolute top-3 left-3 z-10 flex flex-col overflow-hidden rounded-[6px] border border-border bg-background/90 backdrop-blur-[2px]">
      {[...storeys].reverse().map((s) => {
        const active = activeStoreyId === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => setActiveStoreyId(active ? "all" : s.id)}
            className={cn(
              "h-7 w-9 text-[12px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground",
              active && "bg-accent text-accent-foreground",
            )}
          >
            {s.shortName}
          </button>
        );
      })}
    </div>
  );
}

export function ViewControls() {
  const items = [
    { icon: Plus, label: "Zoom in" },
    { icon: Minus, label: "Zoom out" },
    { icon: RotateCcw, label: "Reset view" },
    { icon: Maximize2, label: "Fit model" },
  ];
  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-10 flex overflow-hidden rounded-[6px] border border-border bg-background/90 backdrop-blur-[2px]">
      {items.map((i) => (
        <Tooltip key={i.label}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="grid size-8 place-items-center text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            >
              <i.icon aria-hidden className="size-3.5" />
              <span className="sr-only">{i.label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{i.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

export function RouteControls() {
  const { animation, play, pause, stepForward, resetAnimation, route } = useInfer();
  if (!route || (!animation.playing && animation.stepIndex === 0)) return null;
  const step = route.steps[animation.stepIndex];

  return (
    <div className="pointer-events-auto absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-[6px] border border-border bg-background/95 px-1 py-1 backdrop-blur-[2px]">
      <div className="flex items-center gap-1">
        <span className="max-w-[280px] truncate px-2 text-[12px] text-muted-foreground">{step?.instruction}</span>
        <Btn label={animation.playing ? "Pause" : "Play"} onClick={animation.playing ? pause : play} />
        <Btn label="Previous" onClick={resetAnimation} />
        <Btn label="Next" onClick={stepForward} />
        <Btn label="Exit" onClick={resetAnimation} />
      </div>
    </div>
  );
}

function Btn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[4px] px-2 py-1 text-[12px] text-foreground transition-colors duration-150 hover:bg-muted"
    >
      {label}
    </button>
  );
}
