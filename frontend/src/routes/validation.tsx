import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ValidationIssueList } from "@/components/validation/ValidationIssueList";
import { ValidationIssueDetails } from "@/components/validation/ValidationIssueDetails";
import { validationIssues } from "@/data/mock";
import { EmptyState } from "@/components/common/States";

export const Route = createFileRoute("/validation")({
  head: () => ({
    meta: [
      { title: "Navigation readiness validation — INFER" },
      {
        name: "description",
        content:
          "Review disconnected doors, isolated spaces and incomplete vertical transitions blocking reliable indoor routing.",
      },
      { property: "og:title", content: "Navigation readiness validation — INFER" },
      { property: "og:description", content: "Resolve spatial graph findings before publishing navigation." },
    ],
  }),
  component: ValidationScreen,
});

function ValidationScreen() {
  const [selectedId, setSelectedId] = useState<string | null>(validationIssues[0]?.id ?? null);
  const issue = validationIssues.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_26rem]">
      <div className="min-h-0 overflow-auto border-r border-border">
        <ValidationIssueList selectedId={selectedId} onSelect={(issue) => setSelectedId(issue.id)} />
      </div>
      <aside className="min-h-0 overflow-auto bg-surface-raised" aria-label="Finding details">
        {issue ? (
          <ValidationIssueDetails issue={issue} />
        ) : (
          <EmptyState title="No finding selected" description="Select a finding to inspect its evidence and resolution options." />
        )}
      </aside>
    </div>
  );
}
