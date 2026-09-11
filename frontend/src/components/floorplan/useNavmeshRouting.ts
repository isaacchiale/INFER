import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildAllStoreyNavmeshes,
  findMultiStoreyNavmeshPath,
  findNavmeshPath,
  findNearestExitPath,
} from "@/lib/navmesh";
import type { FootprintsDocument } from "@/types/footprints";
import type { ConnectivityGraph } from "@/types/graph";
import type { NavmeshRoute } from "@/state/infer-store";

/**
 * The click-to-click navmesh routing state machine: which portals are
 * hazard-blocked, whether the current route is an "exit" search, the A-star /
 * nearest-exit recompute whenever pins or the mesh change, and clearing
 * everything on a model switch. Doesn't touch the DOM or pointer events —
 * FloorplanViewer still owns placing pins (it needs the SVG↔world mapping
 * and the storey-scoped mesh to hit-test against) and calls back into
 * `setIsExitRoute`/`setBlockedPortalIds`/the shared `setNavmeshRoute`
 * returned/passed here.
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

  // Every storey's mesh — needed once the end pin can land on a different
  // floor than the start (stairs/lifts bridge them via findMultiStoreyNavmeshPath).
  const allStoreyNavmeshes = useMemo(() => {
    if (!footprintsDocument || !connectivityGraph) return [];
    return buildAllStoreyNavmeshes(footprintsDocument, connectivityGraph, {
      excludedNodeIds,
      excludedEdgeIds,
    });
  }, [footprintsDocument, connectivityGraph, excludedNodeIds, excludedEdgeIds]);

  // Recompute A* whenever pins + mesh change (persists across IFC/navmesh
  // toggle and storey switches — the end pin may be on a different storey).
  useEffect(() => {
    if (!navmeshRoute) {
      setNavmeshPathNote(null);
      return;
    }

    // Exit routes only ever pin a start point — re-find the nearest exit from
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
      if (!sameEnd || !samePoints || navmeshRoute.segments) {
        setNavmeshRoute({
          ...navmeshRoute,
          end: nextEnd,
          endStoreyId: nextEnd ? navmeshRoute.storeyId : null,
          points: nextPoints,
          segments: null,
        });
      }
      return;
    }

    if (!navmeshRoute.end || navmeshRoute.endStoreyId == null) {
      if (navmeshRoute.points || navmeshRoute.segments) {
        setNavmeshRoute({ ...navmeshRoute, points: null, segments: null });
      }
      setNavmeshPathNote(null);
      return;
    }
    if (!footprintsDocument || !connectivityGraph) return;

    const startMesh = allStoreyNavmeshes.find((m) => m.storeyId === navmeshRoute.storeyId);
    const endMesh = allStoreyNavmeshes.find((m) => m.storeyId === navmeshRoute.endStoreyId);
    if (!startMesh || !endMesh) {
      setNavmeshPathNote("Storey mesh unavailable");
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
      const same =
        (navmeshRoute.points == null && nextPoints == null) ||
        (navmeshRoute.points != null &&
          nextPoints != null &&
          navmeshRoute.points.length === nextPoints.length &&
          navmeshRoute.points.every(
            (p, i) => p.x === nextPoints[i]!.x && p.y === nextPoints[i]!.y,
          ));
      if (!same || navmeshRoute.segments) {
        setNavmeshRoute({ ...navmeshRoute, points: nextPoints, segments: null });
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
    if (!sameSegments || navmeshRoute.points) {
      setNavmeshRoute({ ...navmeshRoute, points: null, segments: nextSegments });
    }
  }, [
    allStoreyNavmeshes,
    blockedPortalIds,
    connectivityGraph,
    footprintsDocument,
    isExitRoute,
    navmeshRoute?.storeyId,
    navmeshRoute?.endStoreyId,
    navmeshRoute?.start.x,
    navmeshRoute?.start.y,
    navmeshRoute?.end?.x,
    navmeshRoute?.end?.y,
    setNavmeshRoute,
  ]);

  // Model change → clear pins and path (storey switches and IFC↔navmesh
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
  };
}
