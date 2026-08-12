import { cn } from "@/lib/utils";
import type { DataProvenance, Severity } from "@/types/infer";
import { AlertTriangle, CheckCircle2, CircleDashed, HelpCircle, Info, ShieldAlert, UserCheck } from "lucide-react";

const provenanceMeta: Record<DataProvenance, { label: string; icon: typeof CheckCircle2; className: string }> = {
  verified: { label: "Verified", icon: CheckCircle2, className: "border-verified/40 text-verified bg-verified/8" },
  inferred: { label: "Inferred", icon: CircleDashed, className: "border-inferred/45 text-inferred bg-inferred/10" },
  "user-confirmed": { label: "User confirmed", icon: UserCheck, className: "border-primary/40 text-primary bg-primary/8" },
  "needs-review": { label: "Needs review", icon: HelpCircle, className: "border-invalid/40 text-invalid bg-invalid/8" },
};

export function ProvenanceBadge({
  provenance,
  className,
  compact,
}: {
  provenance: DataProvenance;
  className?: string;
  compact?: boolean;
}) {
  const meta = provenanceMeta[provenance];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium",
        meta.className,
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {!compact && meta.label}
      <span className="sr-only">Data provenance: {meta.label}</span>
    </span>
  );
}

const severityMeta: Record<Severity, { label: string; icon: typeof AlertTriangle; className: string }> = {
  critical: { label: "Critical", icon: ShieldAlert, className: "border-invalid/45 text-invalid bg-invalid/8" },
  major: { label: "Major", icon: AlertTriangle, className: "border-warning/50 text-warning-foreground bg-warning/12" },
  minor: { label: "Minor", icon: Info, className: "border-border text-muted-foreground bg-muted" },
  info: { label: "Info", icon: Info, className: "border-border text-muted-foreground bg-muted" },
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const meta = severityMeta[severity];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium",
        meta.className,
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {meta.label}
    </span>
  );
}
