import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Inspector } from "@/components/panels/Inspector";
import { InferProvider } from "@/state/infer-store";
import { TopBar } from "./TopBar";
import { IngestDialog } from "@/components/ingest/IngestDialog";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <InferProvider>
      <TooltipProvider delayDuration={300}>
        <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
          <TopBar />
          <div className="flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
          </div>
        </div>
        <IngestDialog />
        {/* Selection card — screen-level like toasts, not tied to the 3D pane. */}
        <Inspector />
        <Toaster position="bottom-right" offset="16px" />
      </TooltipProvider>
    </InferProvider>
  );
}
