import {
  runShareExport,
  type ShareExportInput,
  type ShareExportOutput,
} from "@/lib/share-export-core";

type WorkerReply = { ok: true; output: ShareExportOutput } | { ok: false; error: string };

/**
 * Runs the Share export in a Web Worker so rebuilding/clipping/merging a
 * whole building and encoding it twice (GLB + USDZ) never freezes the page.
 *
 * The input is structured-cloned (copied), not transferred: fragments'
 * geometry arrays may be views into buffers it keeps using, and detaching
 * them would corrupt the live viewer. A copy of plain typed arrays is a
 * memcpy — cheap next to the work it moves off the main thread — and it
 * also keeps `input` intact for the in-page fallback below.
 *
 * Falls back to running in the page if the worker can't be created or
 * crashes, so a worker problem degrades to "slower", never to "no share".
 */
export async function exportShareOffThread(input: ShareExportInput): Promise<ShareExportOutput> {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./share-export.worker.ts", import.meta.url), { type: "module" });
    const w = worker;
    const reply = await new Promise<WorkerReply>((resolve, reject) => {
      w.onmessage = (event: MessageEvent<WorkerReply>) => resolve(event.data);
      w.onerror = (event) => reject(new Error(event.message || "Share export worker failed"));
      w.postMessage(input);
    });
    if (!reply.ok) throw new Error(reply.error);
    return reply.output;
  } catch (err) {
    console.warn("Share export: worker unavailable, exporting on the main thread", err);
    return runShareExport(input);
  } finally {
    worker?.terminate();
  }
}
