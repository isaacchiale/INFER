import { building } from "@/data/mock";

export function ReadinessSummary() {
  const segments = [
    { label: "Verified connectivity", value: 62, className: "bg-verified" },
    { label: "Inferred connectivity", value: 22, className: "bg-inferred" },
    { label: "Unresolved", value: 16, className: "bg-invalid/70" },
  ];
  return (
    <section aria-label="Navigation readiness" className="border border-border bg-surface-raised p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="label-caps text-muted-foreground">Navigation readiness</h2>
        <p className="font-mono text-2xl font-semibold text-foreground">
          {building.readinessScore}
          <span className="text-sm text-muted-foreground"> / 100</span>
        </p>
      </div>
      <div
        className="mt-3 flex h-2 w-full overflow-hidden border border-border"
        role="img"
        aria-label={`Navigation readiness ${building.readinessScore} out of 100: 62% verified, 22% inferred, 16% unresolved`}
      >
        {segments.map((s) => (
          <span key={s.label} className={s.className} style={{ width: `${s.value}%` }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span aria-hidden className={`size-2 ${s.className}`} />
            {s.label} · {s.value}%
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        The model is usable for wayfinding. Accessible and emergency routing remain partially inferred until the open
        connectivity findings are resolved.
      </p>
    </section>
  );
}
