import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildAllStoreyNavmeshesAsync,
  buildStoreyGridsAsync,
} from "@/lib/navmesh-worker-client";
import {
  buildStoreyNavmeshesIncremental,
  storeysAffectedByExclusionChange,
  type StoreyNavmesh,
} from "@/lib/navmesh";
import {
  findGridMultiStoreyPath,
  findGridNearestExitPath,
  findGridPath,
  type StoreyGrid,
} from "@/lib/storey-grid";
import type { FootprintsDocument } from "@/types/footprints";
import type { ConnectivityGraph } from "@/types/graph";
import type { NavmeshRoute } from "@/state/infer-store";

/**
 * The click-to-click navmesh routing state machine: which portals are
 * hazard-blocked, whether the current route is an "exit" search, the route
 * recompute whenever pins or the grids change, and clearing everything on a
 * model switch. Doesn't touch the DOM or pointer events ? FloorplanViewer
 * still owns placing pins (it needs the SVG?world mapping and the
 * storey-scoped mesh to hit-test against) and calls back into
 * `setIsExitRoute`/`setBlockedPortalIds`/the shared `setNavmeshRoute`
 * returned/passed here.
 *
 * Meshes build in a Web Worker on model load, then each storey's walkability
 * grid is painted in a second worker call. Exclusion toggles rebuild only the
 * dirty storeys' meshes (main thread) and grids (worker). Routes are one A*
 * per storey over those grids, run on the main thread against the grid
 * objects in React state so their search buffers are reused across clicks.
 */
export function useNavmeshRouting({
  footprintsId,
  footprintsDocument,
  connectivityGraph,
  excludedNodeIds,
  excludedEdgeIds,
  navmeshRoute,
  setNavmeshRoute,
}: {
  footprintsId: string | null;
  footprintsDocument: FootprintsDocument | null;
  connectivityGraph: ConnectivityGraph | null;
  excludedNodeIds: ReadonlySet<string>;
  excludedEdgeIds: ReadonlySet<string>;
  navmeshRoute: NavmeshRoute | null;
  setNavmeshRoute: (route: NavmeshRoute | null) => void;
}) {
  const [navmeshPathNote, setNavmeshPathNote] = useState<string | null>(null);
  /** True when the current navmeshRoute came from exit mode (label + recompute differ). */
  const [isExitRoute, setIsExitRoute] = useState(false);
  /** Hazard/what-if: portals excluded from routing without removing them from the graph. */
  const [blockedPortalIds, setBlockedPortalIds] = useState<Set<string>>(() => new Set());
  /** Mesh or grid build in flight ? drives the floorplan "Recalculating navmesh?" label. */
  const [navmeshBusy, setNavmeshBusy] = useState(false);

  // Every storey's mesh ? needed once the end pin can land on a different
  // floor than the start (stairs/lifts bridge them).
  const [allStoreyNavmeshes, setAllStoreyNavmeshes] = useState<StoreyNavmesh[]>([]);
  const [storeyGrids, setStoreyGrids] = useState<StoreyGrid[]>([]);
  const navmeshCacheRef = useRef<{
    footprints: FootprintsDocument;
    graph: ConnectivityGraph;
    excludedNodes: ReadonlySet<string>;
    excludedEdges: ReadonlySet<string>;
    meshes: StoreyNavmesh[];
  } | null>(null);
  const gridsRef = useRef<StoreyGrid[]>([]);
  /** Bumps on each effect run so a stale grid build can't overwrite newer grids. */
  const buildGenRef = useRef(0);

  useEffect(() => {
    if (!footprintsDocument || !connectivityGraph) {
      navmeshCacheRef.current = null;
      gridsRef.current = [];
      setAllStoreyNavmeshes([]);
      setStoreyGrids([]);
      setNavmeshBusy(false);
      return;
    }

    const prev = navmeshCacheRef.current;
    const baseChanged =
      !prev || prev.footprints !== footprintsDocument || prev.graph !== connectivityGraph;
    const dirty: ReadonlySet<string> | "all" = baseChanged
      ? "all"
      : storeysAffectedByExclusionChange(
          footprintsDocument,
          connectivityGraph,
          prev.excludedNodes,
          excludedNodeIds,
          prev.excludedEdges,
          excludedEdgeIds,
        );
    const remember = (meshes: StoreyNavmesh[]) => {
      navmeshCacheRef.current = {
        footprints: footprintsDocument,
        graph: connectivityGraph,
        excludedNodes: excludedNodeIds,
        excludedEdges: excludedEdgeIds,
        meshes,
      };
    };
    const publishGrids = (grids: StoreyGrid[]) => {
      gridsRef.current = grids;
      setStoreyGrids(grids);
    };

    // Exclusion-only: patch dirty storeys' meshes on the main thread, then
    // repaint just those storeys' grids off-thread.
    if (dirty !== "all" && prev) {
      if (dirty.size === 0) {
        remember(prev.meshes);
        return;
      }
      const gen = ++buildGenRef.current;
      setNavmeshBusy(true);
      const meshes = buildStoreyNavmeshesIncremental(prev.meshes, footprintsDocument, connectivityGraph, {
        excludedNodeIds,
        excludedEdgeIds,
        dirtyStoreyIds: dirty,
      });
      remember(meshes);
      setAllStoreyNavmeshes(meshes);
      void buildStoreyGridsAsync(
        meshes.filter((m) => dirty.has(m.storeyId)),
        footprintsDocument,
      )
        .then((dirtyGrids) => {
          if (gen !== buildGenRef.current) return;
          const byId = new Map(gridsRef.current.map((g) => [g.storeyId, g]));
          for (const g of dirtyGrids) byId.set(g.storeyId, g);
          publishGrids(meshes.map((m) => byId.get(m.storeyId)).filter((g): g is StoreyGrid => !!g));
        })
        .catch((err) => console.error("Storey grid rebuild failed", err))
        .finally(() => {
          if (gen === buildGenRef.current) setNavmeshBusy(false);
        });
      return;
    }

    // Full rebuild (model load / graph identity change) ? off the main thread.
    const gen = ++buildGenRef.current;
    let cancelled = false;
    setNavmeshBusy(true);
    void buildAllStoreyNavmeshesAsync(footprintsDocument, connectivityGraph, {
      excludedNodeIds,
      excludedEdgeIds,
    })
      .then(async (meshes) => {
        if (cancelled || gen !== buildGenRef.current) return;
        remember(meshes);
        setAllStoreyNavmeshes(meshes);
        const grids = await buildStoreyGridsAsync(meshes, footprintsDocument);
        if (cancelled || gen !== buildGenRef.current) return;
        publishGrids(grids);
      })
      .catch((err) => console.error("Navmesh build failed", err))
      .finally(() => {
        if (!cancelled && gen === buildGenRef.current) setNavmeshBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [footprintsDocument, connectivityGraph, excludedNodeIds, excludedEdgeIds]);

  // Recompute the route whenever pins or grids change (persists across
  // IFC/navmesh toggle and storey switches ? the end pin may be on a
  // different storey).
  useEffect(() => {
    if (!navmeshRoute) {
      setNavmeshPathNote(null);
      return;
    }

    const gridFor = (storeyId: string) => storeyGrids.find((g) => g.storeyId === storeyId);
    const meshFor = (storeyId: string) => allStoreyNavmeshes.find((m) => m.storeyId === storeyId);
    const unavailable = navmeshBusy ? "Recalculating navmesh?" : "Storey mesh unavailable";

    // Exit routes only ever pin a start point ? re-find the nearest exit from
    // scratch each time (an exclusion change could make a different exit the
    // closest one, not just invalidate the old path to the same exit).
    if (isExitRoute) {
      const grid = gridFor(navmeshRoute.storeyId);
      const mesh = meshFor(navmeshRoute.storeyId);
      if (!grid || !mesh) {
        setNavmeshPathNote(unavailable);
        return;
      }
      const result = findGridNearestExitPath(grid, mesh, navmeshRoute.start, { blockedPortalIds });
      setNavmeshPathNote(result.found ? null : result.note);
      const nextEnd = result.found ? result.points[result.points.length - 1]! : null;
      const nextPoints = result.found ? result.points : null;
      const nextGraph = result.found ? result.graphNodeIds : null;
      const sameEnd =
        (navmeshRoute.end == null && nextEnd == null) ||
        (navmeshRoute.end != null &&
          nextEnd != null &&
          navmeshRoute.end.x === nextEnd.x &&
          navmeshRoute.end.y === nextEnd.y);
      if (
        !sameEnd ||
        !samePoints(navmeshRoute.points, nextPoints) ||
        navmeshRoute.segments ||
        !sameIds(navmeshRoute.graphNodeIds, nextGraph)
      ) {
        setNavmeshRoute({
          ...navmeshRoute,
          end: nextEnd,
          endStoreyId: nextEnd ? navmeshRoute.storeyId : null,
          points: nextPoints,
          segments: null,
          graphNodeIds: nextGraph,
        });
      }
      return;
    }

    if (!navmeshRoute.end || navmeshRoute.endStoreyId == null) {
      if (navmeshRoute.points || navmeshRoute.segments || navmeshRoute.graphNodeIds) {
        setNavmeshRoute({ ...navmeshRoute, points: null, segments: null, graphNodeIds: null });
      }
      setNavmeshPathNote(null);
      return;
    }
    if (!footprintsDocument || !connectivityGraph) return;

    const startGrid = gridFor(navmeshRoute.storeyId);
    const endGrid = gridFor(navmeshRoute.endStoreyId);
    const startMesh = meshFor(navmeshRoute.storeyId);
    if (!startGrid || !endGrid || !startMesh || !meshFor(navmeshRoute.endStoreyId)) {
      setNavmeshPathNote(unavailable);
      return;
    }

    if (navmeshRoute.storeyId === navmeshRoute.endStoreyId) {
      const result = findGridPath(startGrid, startMesh, navmeshRoute.start, navmeshRoute.end, {
        blockedPortalIds,
      });
      setNavmeshPathNote(result.found ? null : result.note);
      const nextPoints = result.found ? result.points : null;
      const nextGraph = result.found ? result.graphNodeIds : null;
      if (
        !samePoints(navmeshRoute.points, nextPoints) ||
        navmeshRoute.segments ||
        !sameIds(navmeshRoute.graphNodeIds, nextGraph)
      ) {
        setNavmeshRoute({ ...navmeshRoute, points: nextPoints, segments: null, graphNodeIds: nextGraph });
      }
      return;
    }

    const result = findGridMultiStoreyPath(
      storeyGrids,
      allStoreyNavmeshes,
      connectivityGraph,
      footprintsDocument,
      { storeyId: navmeshRoute.storeyId, point: navmeshRoute.start },
      { storeyId: navmeshRoute.endStoreyId, point: navmeshRoute.end },
      { blockedPortalIds },
    );
    setNavmeshPathNote(result.found ? null : result.note);
    const nextSegments = result.found ? result.segments : null;
    const nextGraph = result.found ? result.graphNodeIds : null;
    const sameSegments =
      (navmeshRoute.segments == null && nextSegments == null) ||
      (navmeshRoute.segments != null &&
        nextSegments != null &&
        navmeshRoute.segments.length === nextSegments.length &&
        navmeshRoute.segments.every(
          (s, i) => s.storeyId === nextSegments[i]!.storeyId && samePoints(s.points, nextSegments[i]!.points),
        ));
    if (!sameSegments || navmeshRoute.points || !sameIds(navmeshRoute.graphNodeIds, nextGraph)) {
      setNavmeshRoute({ ...navmeshRoute, points: null, segments: nextSegments, graphNodeIds: nextGraph });
    }
  }, [
    allStoreyNavmeshes,
    storeyGrids,
    blockedPortalIds,
    connectivityGraph,
    footprintsDocument,
    isExitRoute,
    navmeshBusy,
    navmeshRoute?.storeyId,
    navmeshRoute?.endStoreyId,
    navmeshRoute?.start.x,
    navmeshRoute?.start.y,
    navmeshRoute?.end?.x,
    navmeshRoute?.end?.y,
    setNavmeshRoute,
  ]);

  // Model change ? clear pins and path (storey switches and IFC?navmesh
  // toggles preserve an in-progress or cross-storey route).
  const routeScopeRef = useRef(footprintsId);
  useEffect(() => {
    if (routeScopeRef.current === footprintsId) return;
    routeScopeRef.current = footprintsId;
    setNavmeshRoute(null);
    setNavmeshPathNote(null);
    setIsExitRoute(false);
    setBlockedPortalIds(new Set());
  }, [footprintsId, setNavmeshRoute]);

  const clearNavmeshRoute = useCallback(() => {
    setNavmeshRoute(null);
    setNavmeshPathNote(null);
    setIsExitRoute(false);
  }, [setNavmeshRoute]);

  return {
    navmeshPathNote,
    isExitRoute,
    setIsExitRoute,
    blockedPortalIds,
    setBlockedPortalIds,
    allStoreyNavmeshes,
    clearNavmeshRoute,
    navmeshBusy,
  };
}

function samePoints(
  a: readonly { x: number; y: number }[] | null,
  b: readonly { x: number; y: number }[] | null,
): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.length === b.length && a.every((p, i) => p.x === b[i]!.x && p.y === b[i]!.y);
}

function sameIds(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
