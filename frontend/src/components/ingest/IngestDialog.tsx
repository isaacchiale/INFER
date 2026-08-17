import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useInfer } from "@/state/infer-store";
import { buildModelFootprints, buildModelGraph, extractModel, uploadModel } from "@/api/models";
import { toast } from "sonner";

const ACCEPT = [".ifc", ".ifczip"];

export function IngestDialog() {
  const { ingestOpen, setIngestOpen, queueIfcFile, setModelGraph, setViewerStatus } = useInfer();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setFileName(null);
    setProgress(0);
    setStatus("");
    setError(null);
    setDragging(false);
    setLoading(false);
  };

  const start = async (file: File) => {
    const ok = ACCEPT.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!ok) {
      setFileName(file.name);
      setProgress(0);
      setError("Unsupported file. Use .ifc or .ifczip.");
      return;
    }

    setError(null);
    setFileName(file.name);
    setLoading(true);
    setProgress(8);
    setStatus("Loading into 3D viewer…");
    setViewerStatus(`Loading ${file.name}`, "loading");

    try {
      await queueIfcFile(file);
      setProgress(25);
      setStatus("Uploading to backend…");

      const meta = await uploadModel(file);
      setProgress(45);
      setStatus("Extracting spaces / doors / stairs…");

      const entities = await extractModel(meta.model_id);
      setProgress(70);
      setStatus("Building connectivity graph…");

      const graph = await buildModelGraph(meta.model_id);
      setProgress(85);
      setStatus("Building space footprints…");

      const footprints = await buildModelFootprints(meta.model_id);
      setProgress(95);

      setModelGraph({ modelId: meta.model_id, graph, entities, footprints });
      setProgress(100);
      setStatus("Ready");
      setViewerStatus(
        `Graph + footprints ready · ${entities.spaces.length} spaces · ${footprints.spaces.filter((s) => !s.incomplete).length} plans`,
        "info",
      );
      toast.success(
        `Ingested ${file.name}: ${entities.spaces.length} spaces, ${graph.edges.length} links, footprints built`,
      );
      window.setTimeout(() => {
        setIngestOpen(false);
        reset();
      }, 400);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ingest failed";
      setError(message);
      setProgress(0);
      setStatus("");
      setLoading(false);
      setViewerStatus(message, "error");
      toast.error(message);
    }
  };

  return (
    <Dialog
      open={ingestOpen}
      onOpenChange={(v) => {
        setIngestOpen(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-md gap-4 rounded-[8px]">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold">Open model</DialogTitle>
        </DialogHeader>

        {fileName && !error ? (
          <div className="space-y-3 py-2">
            <p className="truncate text-[13px] text-foreground">{fileName}</p>
            <Progress value={progress} className="h-1" aria-label="Load progress" />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-muted-foreground">
                {loading ? status || "Working…" : `${progress}%`}
              </span>
              <Button size="sm" variant="ghost" className="h-7 rounded-[5px] text-[12px]" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void start(file);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-3 rounded-[6px] border border-dashed border-border px-6 py-12 text-center transition-colors duration-150",
              dragging && "border-primary bg-accent/40",
            )}
          >
            <p className="text-[13px] text-muted-foreground">Drop IFC here</p>
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-[5px] text-[13px]"
              onClick={() => inputRef.current?.click()}
            >
              Choose file
            </Button>
            {error && <p className="text-[12px] text-destructive">{error}</p>}
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept=".ifc,.ifczip"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void start(file);
            e.target.value = "";
          }}
        />

        <p className="text-[11px] text-muted-foreground">
          Loads 3D locally, then upload → extract → graph on the backend for the graph viewer. Backend
          must be running on :8000.
        </p>
      </DialogContent>
    </Dialog>
  );
}
