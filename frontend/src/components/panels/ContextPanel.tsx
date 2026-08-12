import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Floating contextual panel that overlays the viewport. */
export function ContextPanel({
  title,
  onClose,
  children,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside
      aria-label={title}
      className={cn(
        "pointer-events-auto absolute top-3 left-3 z-20 flex w-[320px] flex-col overflow-hidden",
        "rounded-[7px] border border-border bg-popover text-popover-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)]",
        "animate-in fade-in-0 slide-in-from-left-1 duration-150",
        className,
      )}
    >
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <h2 className="text-[13px] font-medium">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title}`}
          className="grid size-6 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </header>
      <div className="max-h-[calc(100dvh-8rem)] overflow-auto">{children}</div>
    </aside>
  );
}
