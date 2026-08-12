import { useState } from "react";
import { X } from "lucide-react";
import { spaces, storeys } from "@/data/mock";
import { Button } from "@/components/ui/button";
import { useInfer } from "@/state/infer-store";

export function Inspector() {
  const { selectedElementIds, selectElement, setWorkMode, updateRequest } = useInfer();
  const [showProps, setShowProps] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const id = selectedElementIds[0];
  const space = spaces.find((s) => s.id === id) ?? spaces[0];
  if (!id || !space) return null;
  const storey = storeys.find((s) => s.id === space.storeyId);

  return (
    <aside
      aria-label="Selection"
      className="pointer-events-auto absolute top-3 right-3 z-20 w-[300px] overflow-hidden rounded-[7px] border border-border bg-popover text-popover-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)] animate-in fade-in-0 slide-in-from-right-1 duration-150"
    >
      <div className="flex items-start gap-2 p-3 pb-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-foreground">{space.name}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{storey?.name}</p>
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

      <div className="px-3 pb-3">
        <Button
          size="sm"
          className="h-8 w-full rounded-[5px] text-[13px]"
          onClick={() => {
            updateRequest({ destination: space.name });
            setWorkMode("navigate");
          }}
        >
          Navigate here
        </Button>
      </div>

      <div className="border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
        <p>Space · {space.ifcClass}</p>
        <button
          type="button"
          onClick={() => setShowProps((v) => !v)}
          className="mt-1.5 text-[12px] text-foreground transition-colors hover:text-primary"
        >
          Properties ›
        </button>
      </div>

      {showProps && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border px-3 py-2.5 text-[12px]">
          <Row k="Area" v={`${space.area} m²`} />
          <Row k="Occupancy" v={String(space.occupancy)} />
          <Row k="Category" v={space.category} />
          <Row k="Status" v={space.provenance} />
          <div className="col-span-2">
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="text-[12px] text-foreground transition-colors hover:text-primary"
            >
              Raw data ›
            </button>
          </div>
        </dl>
      )}

      {showRaw && (
        <pre className="max-h-48 overflow-auto border-t border-border bg-muted/40 px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(space, null, 2)}
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
