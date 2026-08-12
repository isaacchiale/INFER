import { validationIssues, building } from "@/data/mock";
import { useInfer } from "@/state/infer-store";
import { cn } from "@/lib/utils";
import { ContextPanel } from "./ContextPanel";

const dot: Record<string, string> = {
  critical: "bg-invalid",
  major: "bg-warning",
  minor: "bg-inferred",
  info: "bg-muted-foreground",
};

export function ValidatePanel({ onClose }: { onClose: () => void }) {
  const { selectedIssueId, setSelectedIssueId, selectElement } = useInfer();
  const critical = validationIssues.filter((i) => i.severity === "critical").length;
  const review = validationIssues.filter((i) => i.severity === "major").length;
  const suggestions = validationIssues.length - critical - review;

  return (
    <ContextPanel title="Validate" onClose={onClose}>
      <div className="border-b border-border p-3">
        <p className="text-[13px] text-foreground">Model health {building.readinessScore}%</p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {critical} critical · {review} review · {suggestions} suggestions
        </p>
      </div>
      <ul>
        {validationIssues.map((issue) => {
          const active = selectedIssueId === issue.id;
          return (
            <li key={issue.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedIssueId(issue.id);
                  selectElement(issue.id);
                }}
                className={cn(
                  "flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted/60",
                  active && "bg-accent",
                )}
              >
                <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", dot[issue.severity])} />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-foreground">{issue.title}</span>
                  {active && <span className="mt-0.5 block text-[12px] text-muted-foreground">{issue.entityLabel}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </ContextPanel>
  );
}
