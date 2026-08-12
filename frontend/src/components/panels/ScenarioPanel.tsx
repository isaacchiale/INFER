import { toast } from "sonner";
import { Ban, Flame, RotateCcw } from "lucide-react";
import { useInfer } from "@/state/infer-store";
import { cn } from "@/lib/utils";
import { ContextPanel } from "./ContextPanel";

export function ScenarioPanel({ onClose }: { onClose: () => void }) {
  const { conditions, addCondition, removeCondition } = useInfer();

  return (
    <ContextPanel title="Scenario" onClose={onClose}>
      <div className="flex flex-col p-2">
        <Action
          icon={Ban}
          label="Block element"
          onClick={() => {
            addCondition({
              id: `cond-${Date.now()}`,
              kind: "stair-unavailable",
              entityLabel: "Stair B",
              storeyId: "st-l3",
              location: "Level 3 core",
              severity: "critical",
              startTime: "now",
              status: "active",
            });
            toast("Stair B blocked", { description: "Route recalculated via Lift L-02." });
          }}
        />
        <Action
          icon={Flame}
          label="Add hazard zone"
          onClick={() => {
            addCondition({
              id: `haz-${Date.now()}`,
              kind: "hazard-zone",
              entityLabel: "Hazard zone",
              storeyId: "st-l3",
              location: "Level 3 east wing",
              severity: "critical",
              startTime: "now",
              status: "active",
            });
            toast("Hazard zone added", { description: "East wing corridor avoided." });
          }}
        />
        <Action
          icon={RotateCcw}
          label="Reset scenario"
          onClick={() => {
            conditions.forEach((c) => removeCondition(c.id));
            toast("Scenario reset");
          }}
        />
      </div>

      {conditions.length > 0 && (
        <ul className="border-t border-border py-1">
          {conditions.map((c) => (
            <li key={c.id} className="flex items-center gap-2.5 px-3 py-1.5 text-[12px]">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-hazard" />
              <span className="min-w-0 flex-1 truncate text-foreground">{c.entityLabel}</span>
              <button
                type="button"
                onClick={() => removeCondition(c.id)}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                Clear
              </button>
            </li>
          ))}
        </ul>
      )}
    </ContextPanel>
  );
}

function Action({ icon: Icon, label, onClick }: { icon: typeof Ban; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-[5px] px-2 py-2 text-left text-[13px] text-foreground",
        "transition-colors duration-150 hover:bg-muted",
      )}
    >
      <Icon aria-hidden className="size-4 text-muted-foreground" />
      {label}
    </button>
  );
}
