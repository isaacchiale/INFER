import { Switch } from "@/components/ui/switch";
import { useInfer } from "@/state/infer-store";
import { ContextPanel } from "./ContextPanel";

export function LayersPanel({ onClose }: { onClose: () => void }) {
  const { layers, toggleLayer } = useInfer();

  return (
    <ContextPanel title="Layers" onClose={onClose} className="w-[280px]">
      <ul className="p-2">
        {layers.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-3 rounded-[5px] px-2 py-1.5 hover:bg-muted/60">
            <label htmlFor={`layer-${l.id}`} className="cursor-pointer text-[13px] text-foreground">
              {l.label}
            </label>
            <Switch id={`layer-${l.id}`} checked={l.visible} onCheckedChange={() => toggleLayer(l.id)} />
          </li>
        ))}
      </ul>
    </ContextPanel>
  );
}
