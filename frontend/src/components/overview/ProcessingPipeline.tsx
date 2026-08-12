import { AlertTriangle, Check, Circle, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProcessingStage } from "@/types/infer";

const icons = {
  complete: Check,
  running: Loader2,
  warning: AlertTriangle,
  failed: XCircle,
  pending: Circle,
} as const;

const tones = {
  complete: "text-verified border-verified/40 bg-verified/8",
  running: "text-primary border-primary/40 bg-primary/8",
  warning: "text-warning-foreground border-warning/50 bg-warning/12",
  failed: "text-invalid border-invalid/40 bg-invalid/8",
  pending: "text-muted-foreground border-border bg-muted",
} as const;

export function ProcessingPipeline({ stages }: { stages: ProcessingStage[] }) {
  return (
    <ol className="divide-y divide-border border border-border bg-surface-raised">
      {stages.map((s) => {
        const Icon = icons[s.status];
        return (
          <li key={s.id} className="flex items-start gap-2.5 p-2.5">
            <span
              className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-sm border", tones[s.status])}
              aria-hidden
            >
              <Icon className={cn("size-3", s.status === "running" && "animate-spin")} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-xs font-medium text-foreground">{s.name}</p>
                {s.timestamp && <p className="shrink-0 font-mono text-[11px] text-muted-foreground">{s.timestamp}</p>}
              </div>
              {s.detail && <p className="text-[11px] text-muted-foreground">{s.detail}</p>}
              <span className="sr-only">Status: {s.status}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
