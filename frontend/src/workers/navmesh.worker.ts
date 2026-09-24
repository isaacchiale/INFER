/**
 * Runs the whole-building navmesh build/search/evacuation-load calls off the
 * main thread. buildAllStoreyNavmeshes rebuilds every storey's portal graph,
 * and computeBuildingEvacuationLoad is a Dijkstra over that combined graph —
 * both scale with the whole building, not one storey, and previously ran
 * synchronously on the main thread (mitigated only by wrapping the state
 * update in startTransition, which reprioritizes the resulting render but
 * doesn't stop the call itself from blocking paint/input for its duration).
 *
 * navmesh.ts's algorithms are untouched — this is a pure transport wrapper,
 * dispatched by function name so navmesh-worker-client.ts doesn't need a
 * bespoke message shape per function. Every argument/return value here is
 * plain data (arrays, Maps, Sets — no class instances or functions), so it
 * survives the structured-clone hop across postMessage as-is.
 */
import {
  buildAllStoreyNavmeshes,
  computeBuildingEvacuationLoad,
  findMultiStoreyNavmeshPath,
  findNavmeshPath,
  findNearestExitPath,
  warmStoreyNavmeshWalkCosts,
} from "@/lib/navmesh";
import { buildStoreyGrids } from "@/lib/storey-grid";

const handlers = {
  buildAllStoreyNavmeshes,
  buildStoreyGrids,
  warmStoreyNavmeshWalkCosts,
  findNavmeshPath,
  findNearestExitPath,
  findMultiStoreyNavmeshPath,
  computeBuildingEvacuationLoad,
} satisfies Record<string, (...args: never[]) => unknown>;

export type NavmeshWorkerHandlers = typeof handlers;

type Request = { id: number; fn: keyof NavmeshWorkerHandlers; args: unknown[] };
type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

// Cast rather than pull in the "webworker" lib: this project's single
// tsconfig already includes "DOM" for the main thread, and DOM/WebWorker
// define conflicting globals (both declare `self` differently), so adding
// "webworker" here would break every other file instead.
const ctx = self as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage: (message: Response) => void };

ctx.onmessage = (event) => {
  const { id, fn, args } = event.data;
  try {
    const handler = handlers[fn] as (...a: unknown[]) => unknown;
    const result = handler(...args);
    ctx.postMessage({ id, ok: true, result });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
