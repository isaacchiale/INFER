import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Accessibility,
  ArrowRight,
  Building2,
  Compass,
  Navigation,
  ShieldAlert,
  Boxes,
  AlertTriangle,
  MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { building, processingStatus, storeys, validationIssues } from "@/data/mock";
import { ReadinessSummary } from "@/components/overview/ReadinessSummary";
import { ProcessingPipeline } from "@/components/overview/ProcessingPipeline";
import { ProvenanceBadge, SeverityBadge } from "@/components/common/StatusBadges";

export const Route = createFileRoute("/overview")({
  head: () => ({
    meta: [
      { title: "Model overview — INFER GeoBIM platform" },
      {
        name: "description",
        content:
          "Navigation readiness, model health and processing history for the HDB Hub architectural model in INFER.",
      },
      { property: "og:title", content: "Model overview — INFER GeoBIM platform" },
      {
        property: "og:description",
        content: "Navigation readiness, model health and processing history for a compiled indoor spatial graph.",
      },
    ],
  }),
  component: OverviewScreen,
});

const applications = [
  { icon: Navigation, label: "Normal wayfinding", status: "Available" },
  { icon: Accessibility, label: "Accessible navigation", status: "Partially verified" },
  { icon: ShieldAlert, label: "Emergency rerouting", status: "Available" },
  { icon: Boxes, label: "Asset navigation", status: "Limited metadata" },
] as const;

const recommendations = [
  { id: "r1", label: "Review probable external exit on Level 1", detail: "Door D-221 lacks Pset_DoorCommon.FireExit." },
  { id: "r2", label: "Resolve disconnected Door D-104", detail: "No space boundaries on either face." },
  { id: "r3", label: "Verify staircase transition between Levels 4 and 5", detail: "Stair S-02 flight ends 0.4 m short." },
];

function OverviewScreen() {
  const health = [
    { label: "Navigation ready", value: "84%", tone: "text-verified" },
    { label: "Disconnected doors", value: "12", tone: "text-invalid" },
    { label: "Isolated spaces", value: "2", tone: "text-invalid" },
    { label: "Incomplete staircase connections", value: "1", tone: "text-warning-foreground" },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-[1500px] space-y-5 p-5">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:flex sm:flex-wrap sm:justify-between">
          <div className="min-w-0">
            <p className="label-caps text-muted-foreground">Project {building.projectId}</p>
            <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{building.name}</h1>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin aria-hidden className="size-3" /> {building.address}
            </p>
          </div>
          <Button asChild className="gap-2">
            <Link to="/">
              Open model workspace <ArrowRight className="size-4" />
            </Link>
          </Button>
        </header>

        <dl className="grid grid-cols-2 border border-border bg-surface-raised md:grid-cols-4 xl:grid-cols-8">
          <Stat label="IFC schema" value={building.schema} />
          <Stat label="Source format" value={building.sourceFormat} />
          <Stat label="Storeys" value={String(building.storeyCount)} />
          <Stat label="Spaces" value={String(building.spaceCount)} />
          <Stat label="Doors" value={String(building.doorCount)} />
          <Stat label="Vertical transitions" value={String(building.verticalTransitionCount)} />
          <Stat label="Probable exits" value={String(building.probableExitCount)} />
          <Stat label="Last processed" value={building.lastProcessed} />
        </dl>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <ReadinessSummary />

            <section className="border border-border bg-surface-raised">
              <h2 className="label-caps border-b border-border px-4 py-2 text-muted-foreground">Model health</h2>
              <ul className="grid grid-cols-2 divide-x divide-y divide-border">
                {health.map((h) => (
                  <li key={h.label} className="p-3">
                    <p className={`font-mono text-lg font-semibold ${h.tone}`}>{h.value}</p>
                    <p className="text-xs text-muted-foreground">{h.label}</p>
                  </li>
                ))}
              </ul>
            </section>

            <section className="border border-border bg-surface-raised">
              <h2 className="label-caps border-b border-border px-4 py-2 text-muted-foreground">Available applications</h2>
              <ul className="divide-y divide-border">
                {applications.map((a) => (
                  <li key={a.label}>
                    <Link to="/" className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent hover:text-accent-foreground">
                      <a.icon aria-hidden className="size-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{a.label}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">{a.status}</span>
                      <ArrowRight aria-hidden className="size-3.5 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="space-y-4">
            <section>
              <h2 className="label-caps mb-1.5 text-muted-foreground">Recent processing</h2>
              <ProcessingPipeline stages={processingStatus.stages} />
            </section>

            <section className="border border-border bg-surface-raised">
              <h2 className="label-caps border-b border-border px-4 py-2 text-muted-foreground">Recommended actions</h2>
              <ul className="divide-y divide-border">
                {recommendations.map((r) => (
                  <li key={r.id} className="flex items-start gap-2.5 px-4 py-2.5">
                    <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground">{r.label}</p>
                      <p className="text-[11px] text-muted-foreground">{r.detail}</p>
                    </div>
                    <Button asChild size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]">
                      <Link to="/validation">Review</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="border border-border bg-surface-raised p-4">
              <h2 className="label-caps mb-2 text-muted-foreground">Georeferencing</h2>
              <div className="flex items-start gap-3">
                <Compass aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground">
                    {building.georeferencing.crs}
                    <ProvenanceBadge provenance="inferred" />
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {building.georeferencing.note}
                  </p>
                </div>
              </div>
              <div className="infer-grid mt-3 flex h-24 items-center justify-center border border-border text-[11px] text-muted-foreground">
                Geospatial overview — site context loads with the published model
              </div>
            </section>

            <section className="border border-border bg-surface-raised">
              <h2 className="label-caps border-b border-border px-4 py-2 text-muted-foreground">Storeys</h2>
              <ul className="divide-y divide-border">
                {[...storeys].reverse().map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                    <Building2 aria-hidden className="size-3.5 text-muted-foreground" />
                    <span className="font-medium text-foreground">{s.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{s.elevation.toFixed(2)} m</span>
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">{s.spaceCount} spaces</span>
                    <span className="w-16">
                      <span aria-hidden className="block h-1 bg-muted">
                        <span className="block h-1 bg-primary" style={{ width: `${s.readiness}%` }} />
                      </span>
                      <span className="sr-only">{s.readiness}% navigation ready</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="border border-border bg-surface-raised">
              <h2 className="label-caps border-b border-border px-4 py-2 text-muted-foreground">Open critical findings</h2>
              <ul className="divide-y divide-border">
                {validationIssues
                  .filter((i) => i.severity === "critical")
                  .map((i) => (
                    <li key={i.id} className="flex items-center gap-2 px-4 py-2 text-xs">
                      <SeverityBadge severity={i.severity} />
                      <span className="truncate text-foreground">{i.title}</span>
                    </li>
                  ))}
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-b border-border p-3 last:border-r-0">
      <dt className="label-caps text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-sm text-foreground">{value}</dd>
    </div>
  );
}
