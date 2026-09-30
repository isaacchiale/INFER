/// <reference lib="webworker" />
import { runShareExport, type ShareExportInput } from "@/lib/share-export-core";

/** One export per message; the client terminates the worker afterwards. */
self.onmessage = async (event: MessageEvent<ShareExportInput>) => {
  try {
    const output = await runShareExport(event.data);
    const transfer = [output.glb, output.usdz].filter((b): b is ArrayBuffer => b !== null);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ ok: true, output }, transfer);
  } catch (err) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
