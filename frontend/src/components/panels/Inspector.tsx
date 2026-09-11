import { useState } from "react";
import { X } from "lucide-react";
import { useModelData, useViewport } from "@/state/infer-store";

const METHOD_LABEL: Record<string, string> = {
  ifc_mesh_xy_outline: "Mesh outline",
  ifc_mesh_xy_hull: "Mesh hull",
  ifc_placement_bbox: "Placement bounding box",
  unavailable: "Unavailable",
};

export function Inspector() {
  const { footprintsDocument, entitiesExtract } = useModelData();
  const { selectedElementIds, selectElement } = useViewport();
  const [showRaw, setShowRaw] = useState(false);

  const rawId = selectedElementIds[0];
  const globalId = rawId?.startsWith("space:") ? rawId.slice("space:".length) : rawId;
  const footprint = globalId
    ? footprintsDocument?.spaces.find((s) => s.global_id === globalId)
    : undefined;
  const entity = globalId
    ? entitiesExtract?.spaces.find((s) => s.global_id === globalId)
    : undefined;
  if (!globalId || (!footprint && !entity)) return null;

  const storeyId = footprint?.storey_global_id ?? entity?.storey_global_id ?? null;
  const storeys = footprintsDocument?.storeys ?? entitiesExtract?.storeys ?? [];
  const storey = storeys.find((s) => s.global_id === storeyId);
  const name = footprint?.name || entity?.name || globalId;

  return (
    <aside
      aria-label="Selection"
      className="pointer-events-auto absolute top-3 right-3 z-20 w-[300px] overflow-hidden rounded-[7px] border border-border bg-popover text-popover-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)] animate-in fade-in-0 slide-in-from-right-1 duration-150"
    >
      <div className="flex items-start gap-2 p-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-foreground">{name}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {storey?.name ?? "Unknown storey"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close selection"
          onClick={() => selectElement(null)}
          className="grid size-6 shrink-0 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {footprint ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border px-3 py-2.5 text-[12px]">
          <Row k="Derived from" v={METHOD_LABEL[footprint.method] ?? footprint.method} />
          <Row k="Vertices" v={String(footprint.polygon.length)} />
          {footprint.holes?.length ? <Row k="Holes" v={String(footprint.holes.length)} /> : null}
          {footprint.incomplete ? <Row k="Status" v="Incomplete geometry" /> : null}
        </dl>
      ) : null}

      <div className="border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="text-[12px] text-foreground transition-colors hover:text-primary"
        >
          Raw data ›
        </button>
      </div>

      {showRaw && (
        <pre className="max-h-48 overflow-auto border-t border-border bg-muted/40 px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(footprint ?? entity, null, 2)}
        </pre>
      )}
    </aside>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-foreground">{v}</dd>
    </>
  );
}
