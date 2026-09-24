import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildAllStoreyNavmeshesAsync,
  warmStoreyNavmeshWalkCostsAsync,
} from "@/lib/navmesh-worker-client";
import {
  buildStoreyNavmeshesIncremental,
  findMultiStoreyNavmeshPath,
  findNavmeshPath,
  findNearestExitPath,
  storeysAffectedByExclusionChange,
  type StoreyNavmesh,
} from "@/lib/navmesh";
import type { FootprintsDocument } from "@/types/footprints";
import type { ConnectivityGraph } from "@/types/graph";
import type { NavmeshRoute } from "@/state/infer-store";

/**
 * The click-to-click navmesh routing state machine: which portals are
 * hazard-blocked, whether the current route is an "exit" search, the A-star /
 * nearest-exit recompute whenever pins or the mesh change, and clearing
 * everything on a model switch. Doesn't touch the DOM or pointer events ?
 * FloorplanViewer still owns placing pins (it needs the SVG?world mapping
 * and the storey-scoped mesh to hit-test against) and calls back into
 * `setIsExitRoute`/`setBlockedPortalIds`/the shared `setNavmeshRoute`
 * returned/passed here.
 *
 * Initial / full-building mesh builds run in a Web Worker so Trapelo-scale
 * loads don't freeze the tab. Door?door walk costs warm in a second worker
 * pass after meshes are already usable (baking inside the build hung the
 * worker so navigation never came back). Exclusion toggles use
 * {@link buildStoreyNavmeshesIncremental} on the main thread (usually one
 * dirty storey), then warm those dirty meshes off-thread. Path searches run
 * sync on the main thread against the stable mesh objects in React state so
 * the WeakMap portal-core cache actually hits across clicks.
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
  /** Mesh build and/or door?door cost warm in flight ? drives the floorplan chip. */
  const [navmeshBusy, setNavmeshBusy] = useState(false);

  // Every storey's mesh ? needed once the end pin can land on a different
  // floor than the start (stairs/lifts bridge them via findMultiStoreyNavmeshPath).
  const [allStoreyNavmeshes, setAllStoreyNavmeshes] = useState<StoreyNavmesh[]>([]);
  const navmeshCacheRef = useRef<{
    footprints: FootprintsDocument;
    graph: ConnectivityGraph;
    excludedNodes: ReadonlySet<string>;
    excludedEdges: ReadonlySet<string>;
    meshes: StoreyNavmesh[];
  } | null>(null);
  /** Bumps on each effect run so stale warm results don't overwrite newer meshes. */
  const buildGenRef = useRef(0);

  useEffect(() => {
    if (!footprintsDocument || !connectivityGraph) {
      navmeshCacheRef.current = null;
      setAllStoreyNavmeshes([]);
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

    // Exclusion-only: patch dirty storeys on the main thread (cheap geometry),
    // then warm walk costs for those storeys off-thread.
    if (dirty !== "all" && prev) {
      if (dirty.size === 0) {
        navmeshCacheRef.current = {
          footprints: footprintsDocument,
          graph: connectivityGraph,
          excludedNodes: excludedNodeIds,
          excludedEdges: excludedEdgeIds,
          meshes: prev.meshes,
        };
        return;
      }
      const gen = ++buildGenRef.current;
      setNavmeshBusy(true);
      const meshes = buildStoreyNavmeshesIncremental(
        prev.meshes,
        footprintsDocument,
        connectivityGraph,
        {
          excludedNodeIds,
          excludedEdgeIds,
          dirtyStoreyIds: dirty,
        },
      );
      navmeshCacheRef.current = {
        footprints: footprintsDocument,
        graph: connectivityGraph,
        excludedNodes: excludedNodeIds,
        excludedEdges: excludedEdgeIds,
        meshes,
      };
      setAllStoreyNavmeshes(meshes);

      const dirtyMeshes = meshes.filter((m) => dirty.has(m.storeyId));
      void warmStoreyNavmeshWalkCostsAsync(dirtyMeshes, footprintsDocument)
        .then((warmedDirty) => {
          if (gen !== buildGenRef.current) return;
          const byId = new Map(warmedDirty.map((m) => [m.storeyId, m]));
          const next = meshes.map((m) => byId.get(m.storeyId) ?? m);
          navmeshCacheRef.current = {
            footprints: footprintsDocument,
            graph: connectivityGraph,
            excludedNodes: excludedNodeIds,
            excludedEdges: excludedEdgeIds,
            meshes: next,
          };
          setAllStoreyNavmeshes(next);
        })
        .catch(() => {
          /* keep unwarmed meshes ? routing still works via lazy resolve */
        })
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
        navmeshCacheRef.current = {
          footprints: footprintsDocument,
          graph: connectivityGraph,
          excludedNodes: excludedNodeIds,
          excludedEdges: excludedEdgeIds,
          meshes,
        };
        // Publish meshes immediately so click-to-click works; warm costs next.
        setAllStoreyNavmeshes(meshes);
        try {
          const warmed = await warmStoreyNavmeshWalkCostsAsync(
            meshes,
            footprintsDocument,
          );
          if (cancelled || gen !== buildGenRef.current) return;
          navmeshCacheRef.current = {
            footprints: footprintsDocument,
            graph: connectivityGraph,
            excludedNodes: excludedNodeIds,
            excludedEdges: excludedEdgeIds,
            meshes: warmed,
          };
          setAllStoreyNavmeshes(warmed);
        } catch {
          /* keep unwarmed ? lazy resolve still routes */
        }
      })
      .catch(() => {
        /* leave previous meshes if any */
      })
      .finally(() => {
        if (!cancelled && gen === buildGenRef.current) setNavmeshBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [footprintsDocument, connectivityGraph, excludedNodeIds, excludedEdgeIds]);

  // Recompute A* whenever pins + mesh change (persists across IFC/navmesh
  // toggle and storey switches ? the end pin may be on a different storey).
  useEffect(() => {
    if (!navmeshRoute) {
      setNavmeshPathNote(null);
      return;
    }

    // Exit routes only ever pin a start point ? re-find the nearest exit from
    // scratch each time (an exclusion change could make a different exit the
    // closest one, not just invalidate the old path to the same exit).
    if (isExitRoute) {
      if (!footprintsDocument) return;
      const mesh = allStoreyNavmeshes.find((m) => m.storeyId === navmeshRoute.storeyId);
      if (!mesh) {
        setNavmeshPathNote("Storey mesh unavailable");
        return;
      }
      const result = findNearestExitPath(mesh, navmeshRoute.start, footprintsDocument, {
        blockedPortalIds,
      });
      setNavmeshPathNote(result.found ? null : result.note);
      const nextEnd = result.found ? result.points[result.points.length - 1]! : null;
      const nextPoints = result.found ? result.points : null;
      const sameEnd =
        (navmeshRoute.end == null && nextEnd == null) ||
        (navmeshRoute.end != null &&
          nextEnd != null &&
          navmeshRoute.end.x === nextEnd.x &&
          navmeshRoute.end.y === nextEnd.y);
      const samePoints =
        (navmeshRoute.points == null && nextPoints == null) ||
        (navmeshRoute.points != null &&
          nextPoints != null &&
          navmeshRoute.points.length === nextPoints.length &&
          navmeshRoute.points.every(
            (p, i) => p.x === nextPoints[i]!.x && p.y === nextPoints[i]!.y,
          ));
      const nextGraph = result.found ? result.graphNodeIds : null;
      const sameGraphNodes =
        (navmeshRoute.graphNodeIds == null && nextGraph == null) ||
        (navmeshRoute.graphNodeIds != null &&
          nextGraph != null &&
          navmeshRoute.graphNodeIds.length === nextGraph.length &&
          navmeshRoute.graphNodeIds.every((id, i) => id === nextGraph[i]));
      if (!sameEnd || !samePoints || navmeshRoute.segments || !sameGraphNodes) {
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
        setNavmeshRoute({
          ...navmeshRoute,
          points: null,
          segments: null,
          graphNodeIds: null,
        });
      }
      setNavmeshPathNote(null);
      return;
    }
    if (!footprintsDocument || !connectivityGraph) return;

    const startMesh = allStoreyNavmeshes.find((m) => m.storeyId === navmeshRoute.storeyId);
    const endMesh = allStoreyNavmeshes.find((m) => m.storeyId === navmeshRoute.endStoreyId);
    if (!startMesh || !endMesh) {
      setNavmeshPathNote(
        navmeshBusy ? "Recalculating navmesh?" : "Storey mesh unavailable",
      );
      return;
    }

    if (navmeshRoute.storeyId === navmeshRoute.endStoreyId) {
      const result = findNavmeshPath(
        startMesh,
        navmeshRoute.start,
        navmeshRoute.end,
        footprintsDocument,
        { blockedPortalIds },
      );
      setNavmeshPathNote(result.found ? null : result.note);
      const nextPoints = result.found ? result.points : null;
      const nextGraph = result.found ? result.graphNodeIds : null;
      const same =
        (navmeshRoute.points == null && nextPoints == null) ||
        (navmeshRoute.points != null &&
          nextPoints != null &&
          navmeshRoute.points.length === nextPoints.length &&
          navmeshRoute.points.every(
            (p, i) => p.x === nextPoints[i]!.x && p.y === nextPoints[i]!.y,
          ));
      const sameGraphNodes =
        (navmeshRoute.graphNodeIds == null && nextGraph == null) ||
        (navmeshRoute.graphNodeIds != null &&
          nextGraph != null &&
          navmeshRoute.graphNodeIds.length === nextGraph.length &&
          navmeshRoute.graphNodeIds.every((id, i) => id === nextGraph[i]));
      if (!same || navmeshRoute.segments || !sameGraphNodes) {
        setNavmeshRoute({
          ...navmeshRoute,
          points: nextPoints,
          segments: null,
          graphNodeIds: nextGraph,
        });
      }
      return;
    }

    const result = findMultiStoreyNavmeshPath(
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
          (s, i) =>
            s.storeyId === nextSegments[i]!.storeyId &&
            s.points.length === nextSegments[i]!.points.length &&
            s.points.every(
              (p, j) =>
                p.x === nextSegments[i]!.points[j]!.x && p.y === nextSegments[i]!.points[j]!.y,
            ),
        ));
    const sameGraphNodes =
      (navmeshRoute.graphNodeIds == null && nextGraph == null) ||
      (navmeshRoute.graphNodeIds != null &&
        nextGraph != null &&
        navmeshRoute.graphNodeIds.length === nextGraph.length &&
        navmeshRoute.graphNodeIds.every((id, i) => id === nextGraph[i]));
    if (!sameSegments || navmeshRoute.points || !sameGraphNodes) {
      setNavmeshRoute({
        ...navmeshRoute,
        points: null,
        segments: nextSegments,
        graphNodeIds: nextGraph,
      });
    }
  }, [
    allStoreyNavmeshes,
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
  // toggles now preserve an in-progress or cross-storey route).
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
