import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInfer } from "@/state/infer-store";
import { ContextPanel } from "./ContextPanel";

export function NavigatePanel({ onClose }: { onClose: () => void }) {
  const { request, updateRequest, route, computing, computeRoute, play, animation } = useInfer();
  const [showOptions, setShowOptions] = useState(false);
  const [details, setDetails] = useState(false);

  return (
    <ContextPanel title="Navigate" onClose={onClose}>
      <div className="space-y-2.5 p-3">
        <Field label="From" value={request.origin} onChange={(v) => updateRequest({ origin: v })} />
        <Field label="To" value={request.destination} onChange={(v) => updateRequest({ destination: v })} />

        <button
          type="button"
          onClick={() => setShowOptions((v) => !v)}
          className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Options
          <ChevronDown className={`size-3 transition-transform duration-150 ${showOptions ? "rotate-180" : ""}`} />
        </button>

        {showOptions && (
          <div className="space-y-1.5 border-l border-border pl-2.5 text-[12px]">
            {(
              [
                ["accessible", "Step-free"],
                ["fastest", "Fastest"],
                ["lowest-risk", "Lowest risk"],
              ] as const
            ).map(([mode, label]) => (
              <label key={mode} className="flex cursor-pointer items-center gap-2 text-foreground">
                <input
                  type="radio"
                  name="route-mode"
                  className="accent-primary"
                  checked={request.mode === mode}
                  onChange={() => updateRequest({ mode })}
                />
                {label}
              </label>
            ))}
          </div>
        )}

        <Button size="sm" className="h-8 w-full rounded-[5px] text-[13px]" disabled={computing} onClick={computeRoute}>
          {computing ? "Finding…" : "Find route"}
        </Button>
      </div>

      {route && !computing && (
        <div className="border-t border-border p-3">
          <p className="font-medium text-[13px] text-foreground">
            {Math.round(route.duration / 60)} min · {route.distance} m · {route.storeysTraversed.length} floors
          </p>
          <div className="mt-2.5 flex items-center gap-1.5">
            <Button
              size="sm"
              className="h-8 flex-1 rounded-[5px] text-[13px]"
              variant={animation.playing ? "secondary" : "default"}
              onClick={play}
            >
              Start
            </Button>
            <Button size="sm" variant="ghost" className="h-8 rounded-[5px] text-[12px] text-muted-foreground">
              Alternative
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 rounded-[5px] text-[12px] text-muted-foreground"
              onClick={() => setDetails((v) => !v)}
            >
              Details
            </Button>
          </div>

          {details && (
            <ol className="mt-3 space-y-2 border-t border-border pt-3">
              {route.steps.map((s, i) => (
                <li key={s.id} className="flex gap-2.5 text-[12px]">
                  <span className="w-4 shrink-0 text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className="text-foreground">{s.instruction}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </ContextPanel>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-[5px] border-border text-[13px] shadow-none"
      />
    </label>
  );
}
