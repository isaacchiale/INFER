/**
 * Async front for navmesh.worker.ts: the whole-building navmesh
 * build/search/evacuation-load calls, run off the main thread instead of
 * freezing the tab for their duration (see the worker's own docstring for
 * why — buildAllStoreyNavmeshes and computeBuildingEvacuationLoad scale with
 * the whole building, not one storey).
 *
 * Falls back to calling navmesh.ts directly and wrapping the result in a
 * resolved Promise when Workers aren't available (SSR render, or a
 * test/JSDOM environment) — callers always get the same async interface
 * either way, so useNavmeshRouting.ts/FloorplanViewer.tsx don't need a
 * separate code path for it.
 */
import type {
  buildAllStoreyNavmeshes,
  computeBuildingEvacuationLoad,
  findMultiStoreyNavmeshPath,
  findNavmeshPath,
  findNearestExitPath,
} from "@/lib/navmesh";

type Handlers = {
  buildAllStoreyNavmeshes: typeof buildAllStoreyNavmeshes;
  findNavmeshPath: typeof findNavmeshPath;
  findNearestExitPath: typeof findNearestExitPath;
  findMultiStoreyNavmeshPath: typeof findMultiStoreyNavmeshPath;
  computeBuildingEvacuationLoad: typeof computeBuildingEvacuationLoad;
};

type FnName = keyof Handlers;

type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
let inlineHandlers: Promise<Handlers> | null = null;

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  worker = new Worker(new URL("../workers/navmesh.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (event.data.ok) entry.resolve(event.data.result);
    else entry.reject(new Error(event.data.error));
  };
  // Without these, a failed worker module load (or crash) leaves every
  // pending call hanging forever — FloorplanViewer's "Evacuation load
  // computing…" spinner never clears.
  const failAll = (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
    worker = null;
  };
  worker.onerror = (event) => {
    failAll(event.message || "navmesh worker error");
  };
  worker.onmessageerror = () => {
    failAll("navmesh worker messageerror");
  };
  return worker;
}

async function call<F extends FnName>(fn: F, args: Parameters<Handlers[F]>): Promise<ReturnType<Handlers[F]>> {
  const w = getWorker();
  if (!w) {
    // No Worker support in this environment — run inline, still async.
    inlineHandlers ??= import("@/lib/navmesh");
    const handlers = (await inlineHandlers) as unknown as Handlers;
    return (handlers[fn] as (...a: unknown[]) => unknown)(...args) as ReturnType<Handlers[F]>;
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    w.postMessage({ id, fn, args });
  });
}

export const buildAllStoreyNavmeshesAsync = (...args: Parameters<typeof buildAllStoreyNavmeshes>) =>
  call("buildAllStoreyNavmeshes", args);

export const findNavmeshPathAsync = (...args: Parameters<typeof findNavmeshPath>) =>
  call("findNavmeshPath", args);

export const findNearestExitPathAsync = (...args: Parameters<typeof findNearestExitPath>) =>
  call("findNearestExitPath", args);

export const findMultiStoreyNavmeshPathAsync = (...args: Parameters<typeof findMultiStoreyNavmeshPath>) =>
  call("findMultiStoreyNavmeshPath", args);

export const computeBuildingEvacuationLoadAsync = (...args: Parameters<typeof computeBuildingEvacuationLoad>) =>
  call("computeBuildingEvacuationLoad", args);
