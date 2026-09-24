"""
Build 2D footprints for every space (and door portal) that enters the navigation graph.

Method (spaces / furniture):
1. Prefer ifcopenshell.geom mesh → keep nearly-horizontal faces (floor/ceiling) →
   project to XY → boundary-edge stitch → exterior + holes (ifc_mesh_xy_outline).
   Full 3D meshes are not used for boundary edges: floor+ceiling would double-count
   every plan edge and force a convex-hull fallback. Furniture uses the exterior
   ring only (obstacle polygon); tiny measured outlines are dropped.
2. Fallback: convex hull of mesh XY (ifc_mesh_xy_hull).
3. Fallback: local placement origin ± OverallWidth/Depth (ifc_placement_bbox).
   Furniture requires both dimensions (no invented 1×1 m box).
4. If neither works → incomplete=True, empty polygon (spaces/walls); furniture
   returns None instead.
5. Furniture that does not intersect a person-height band above its storey
   floor (see `_WALK_BAND_*`) is dropped — ceiling fixtures must not appear
   on the plan or block routing.

Stairs stay on convex hull / bbox for plan overlay (v1).
Door portals use mesh plan hull (thin rectangle + facing normal) when possible,
else ObjectPlacement axes / OverallWidth×OverallDepth, else a point only.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Callable, Iterable, TypeVar
import logging
import math
import os

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np

from app.schemas.footprints import (
    DoorPortal,
    FootprintsDocument,
    FurnitureFootprint,
    OpeningPortal,
    Point2D,
    SpaceFootprint,
    StairFootprint,
    StoreyFootprintMeta,
    WallFootprint,
)
from app.services.graph import _gid, _name, _storey_gid
from app.services.ifc_units import length_to_metres

logger = logging.getLogger(__name__)

# Quantize XY when matching mesh edges (metres).
_XY_NDIGITS = 4
# Douglas–Peucker simplify epsilon (metres) for noisy outlines.
_SIMPLIFY_EPS_M = 0.05
# Drop furniture hulls smaller than this (m^2) — wall-mounted clocks, picture
# frames, and other near-zero-footprint items that would clutter the local
# pathfinding obstacle set without ever actually blocking a walkable route.
_MIN_FURNITURE_AREA_M2 = 0.05
# Person-height band above the storey's finished-floor elevation. Only
# furniture whose mesh (or placement prism) intersects this band is kept as
# a plan/nav obstacle — ceiling lights, sprinklers, and other overhead
# IfcFurnishingElement junk are dropped even when IFC containment / nearest-
# storey Z tagged them onto the wrong floor (3D still looks right because it
# clips by real mesh height; the plan only had the label).
_WALK_BAND_MIN_M = 0.15
_WALK_BAND_MAX_M = 2.10
# No tessellated mesh: treat ObjectPlacement Z as the base of a short prism
# so floor-rooted desks with only a placement bbox still clear the band.
_PLACEMENT_ASSUMED_HEIGHT_M = 1.0


def _unique_xy(points: Iterable[tuple[float, float]], tol: float = 1e-6) -> list[tuple[float, float]]:
    """
    Drop near-duplicate points (shared vertices between adjacent mesh
    triangles, or floating-point noise from a coordinate transform), keeping
    the first occurrence of each and preserving order.

    This used to check every new point against every point already kept —
    quadratic in the number of *unique* points, not just points seen, since
    the "already kept" list itself grows. Real mesh vertex counts are
    usually small enough not to notice, but one dense element in a real
    "existing conditions" survey-style IFC export (independently modeled
    geometry per instance, not simple repeated typed furniture — see
    _build_mesh_index's docstring on that distinction) was enough to hang
    an ingest request for many minutes: confirmed live via a py-spy stack
    dump landing in this exact function while processing one
    IfcFurnishingElement, not assumed from reading the code.

    Fixed by snapping each point to a `tol`-sized grid cell and using that
    as a dict key for O(1) average-case lookup — a hash-based dedup instead
    of an all-pairs scan. tol defaults to 1e-6 (a micrometre at this app's
    metre scale), far tighter than any real distinction between two mesh
    vertices, so grid-snapping cannot merge two points a caller would
    actually consider distinct. The one behavioral difference from the old
    all-pairs version is a purely theoretical one: a *chain* of points each
    within tol of the next, spanning further than tol end-to-end, no longer
    transitively merges into one point. That chain-merging was never the
    intent here (this dedupes near-identical vertices, not a clustering
    algorithm) and duplicate mesh vertices in practice sit at identical or
    bit-noise-identical positions, not spread along such a chain.
    """
    seen: dict[tuple[float, float], tuple[float, float]] = {}
    inv_tol = 1.0 / tol
    for x, y in points:
        key = (round(x * inv_tol), round(y * inv_tol))
        if key not in seen:
            seen[key] = (x, y)
    return list(seen.values())


def _qxy(x: float, y: float) -> tuple[float, float]:
    return (round(x, _XY_NDIGITS), round(y, _XY_NDIGITS))


def _cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _signed_area(ring: list[tuple[float, float]]) -> float:
    if len(ring) < 3:
        return 0.0
    acc = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        acc += x1 * y2 - x2 * y1
    return acc * 0.5


def _point_in_ring(x: float, y: float, ring: list[tuple[float, float]]) -> bool:
    if len(ring) < 3:
        return False
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi:
            inside = not inside
        j = i
    return inside


def _convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    pts = _unique_xy(points)
    if len(pts) <= 1:
        return pts
    pts = sorted(pts)
    if len(pts) == 2:
        return pts

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and _cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)

    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and _cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)

    return lower[:-1] + upper[:-1]


def _rdp(points: list[tuple[float, float]], epsilon: float) -> list[tuple[float, float]]:
    """Ramer–Douglas–Peucker polyline simplification (open or closed ring without repeating first)."""
    if len(points) < 3:
        return points

    def _perp_dist(p, a, b) -> float:
        ax, ay = a
        bx, by = b
        px, py = p
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        if len2 < 1e-18:
            return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
        qx, qy = ax + t * dx, ay + t * dy
        return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5

    def _rec(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if len(pts) < 3:
            return pts
        a, b = pts[0], pts[-1]
        idx = 1
        best = -1.0
        for i in range(1, len(pts) - 1):
            d = _perp_dist(pts[i], a, b)
            if d > best:
                best = d
                idx = i
        if best > epsilon:
            left = _rec(pts[: idx + 1])
            right = _rec(pts[idx:])
            return left[:-1] + right
        return [a, b]

    return _rec(points)


def _simplify_ring(ring: list[tuple[float, float]], eps: float = _SIMPLIFY_EPS_M) -> list[tuple[float, float]]:
    if len(ring) < 4:
        return ring
    # Treat as closed: drop duplicate closing vertex if present, RDP, ensure ≥3.
    pts = list(ring)
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    simplified = _rdp(pts + [pts[0]], eps)
    if simplified and simplified[0] == simplified[-1]:
        simplified = simplified[:-1]
    return simplified if len(simplified) >= 3 else ring


_MeshData = tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]


def _build_mesh_index(ifc, elements: Iterable) -> dict[str, _MeshData]:
    """
    Compute world-space verts+faces for every element footprint extraction
    will need, keyed by GlobalId, tessellating each *distinct shape* only
    once no matter how many instances of it exist in the model.

    This replaces calling ifcopenshell.geom.create_shape() once per
    *element*, in a plain Python loop, for every wall/door/space/opening/
    stair/furniture item. That was the actual cause of "importing a bigger
    building hangs the tab": it's single-threaded, and — this is the part
    that matters, confirmed by profiling rather than assumed — OpenCascade's
    BRep-to-triangle-mesh tessellation is genuinely re-run from scratch for
    every single element, even when two elements share the exact same
    IfcRepresentation. A real building places the same chair/desk/cabinet
    hundreds of times via one shared, typed/mapped representation (verified
    against a real uploaded model: 14 desks, all sharing one
    IfcRepresentationMap), and furniture is exactly the element type that
    does this most, so furniture-heavy floors paid full tessellation cost
    per instance for geometry that was byte-identical every time.

    ifcopenshell does NOT dedupe this for you — per-instance
    create_shape()/iterator() calls cost the same whether or not another
    instance already tessellated the identical representation a moment ago
    (confirmed: back-to-back create_shape() calls on two elements sharing one
    representation both took ~70ms; the iterator's per-item cost stayed flat
    from 14 to 2114 instances). So the caching has to happen here:

    1. Group elements by `element.Representation`'s STEP id — elements
       sharing that id have byte-identical shape geometry, differing only in
       where their own ObjectPlacement puts them in the world.
    2. Tessellate exactly one representative per unique representation, in
       LOCAL (object-space) coordinates, via a single multithreaded
       ifcopenshell.geom.iterator() pass (a big building can still have
       hundreds of *distinct* shapes even after this dedup, so this step
       alone is still worth parallelizing).
    3. For every actual element instance, resolve its own world transform
       via ifcopenshell.util.placement.get_local_placement() and apply it to
       the cached local mesh with numpy — a 4x4 matmul over a few hundred
       verts, vs. re-running OpenCascade.

    ifcopenshell.util.placement's matrix translation comes back in the
    file's raw length unit (millimetres on the model this was profiled
    against), while ifcopenshell.geom's vertices are already in metres —
    the translation column has to be scaled by the file's unit_scale before
    it's applied, or every transformed vertex ends up off by the unit ratio
    (caught by spot-checking transformed verts against a direct
    world-coords create_shape() call — silently wrong by ~1000x before this
    scaling was added, not an exception, so it would not have failed loudly).

    On a synthetic stress model (2,114 furniture instances built from 14
    real shared-geometry desks pulled from an actual uploaded building,
    replicated 150x each) this cut the full build_footprints() call from
    339.5s to 15.75s — a ~21x wall-clock speedup — because the 14 real
    shapes get tessellated once each instead of 2,114 times. Verified
    byte-identical output against the pre-fix implementation on both that
    stress model and a real uploaded model for every wall/stair/space/
    furniture footprint; door/opening centroids differ at the ~1e-15
    (floating-point noise) level, which for two doors in the real model was
    enough to flip a pre-existing near-degenerate tie in _convex_hull's edge
    selection and shift that door's reported centre by a few cm — a latent
    sensitivity in the hull tie-break for near-collinear points, not
    something this change created (the underlying point cloud was confirmed
    identical to 1e-15 before hull processing). Where an IFC exporter
    genuinely doesn't share representations across instances, this degrades
    gracefully to one tessellation per element (no worse than before, just
    no better) rather than failing.

    `elements` scopes the whole pass to exactly what footprint extraction
    touches (walls, doors, spaces, openings, stairs + their aggregated
    parts, furniture) rather than every product in the file — a detailed
    architectural/MEP export can carry many times that many ducts, pipes,
    and structural members this module never looks at.
    """
    all_elements = [el for el in elements if el is not None]
    index: dict[str, _MeshData] = {}
    if not all_elements:
        return index

    representative_by_rep_id: dict[int, object] = {}
    elements_by_rep_id: dict[int, list] = defaultdict(list)
    for el in all_elements:
        rep = getattr(el, "Representation", None)
        if rep is None:
            continue
        rep_id = rep.id()
        representative_by_rep_id.setdefault(rep_id, el)
        elements_by_rep_id[rep_id].append(el)

    if not representative_by_rep_id:
        return index

    rep_id_by_guid = {el.GlobalId: rep_id for rep_id, el in representative_by_rep_id.items()}

    local_settings = ifcopenshell.geom.settings()
    local_settings.set(local_settings.USE_WORLD_COORDS, False)
    thread_count = max(1, os.cpu_count() or 1)
    representatives = list(representative_by_rep_id.values())
    iterator = ifcopenshell.geom.iterator(local_settings, ifc, thread_count, include=representatives)

    local_mesh_by_rep_id: dict[int, tuple[np.ndarray, list[tuple[int, int, int]]]] = {}
    if iterator.initialize():
        while True:
            elem = iterator.get()
            try:
                raw_verts = elem.geometry.verts
                local_verts = np.array(raw_verts, dtype=float).reshape(-1, 3)
                raw_faces = elem.geometry.faces
                faces = [
                    (int(raw_faces[i]), int(raw_faces[i + 1]), int(raw_faces[i + 2]))
                    for i in range(0, len(raw_faces), 3)
                ]
                local_mesh_by_rep_id[rep_id_by_guid[elem.guid]] = (local_verts, faces)
            except Exception:  # noqa: BLE001
                logger.debug("no mesh geometry for representative element %s", getattr(elem, "guid", "?"), exc_info=True)
            if not iterator.next():
                break

    if iterator.had_error_processing_elements():
        # Not fatal — every caller already falls back to a placement bbox (or
        # is dropped/marked incomplete) when an element has no mesh here,
        # same as a single create_shape() failure did before. This is purely
        # visibility: previously each failure vanished into a per-element
        # logger.debug call that nobody enables in production.
        affected = sum(len(elements_by_rep_id[rep_id]) for rep_id in representative_by_rep_id)
        logger.warning(
            "ifcopenshell geometry iterator hit errors tessellating some of %d distinct shape(s), "
            "affecting up to %d element instance(s); affected elements fall back to a placement "
            "bounding box, or are dropped entirely if that fails too: %s",
            len(representatives),
            affected,
            iterator.getLog(),
        )

    unit_scale = ifcopenshell.util.unit.calculate_unit_scale(ifc)
    for rep_id, (local_verts, faces) in local_mesh_by_rep_id.items():
        homogeneous = np.hstack([local_verts, np.ones((local_verts.shape[0], 1))])
        for el in elements_by_rep_id[rep_id]:
            placement = getattr(el, "ObjectPlacement", None)
            if placement is None:
                continue
            try:
                matrix = ifcopenshell.util.placement.get_local_placement(placement).copy()
                matrix[:3, 3] *= unit_scale
                world_verts = (matrix @ homogeneous.T).T[:, :3]
            except Exception:  # noqa: BLE001
                logger.debug("could not place element %s", _gid(el), exc_info=True)
                continue
            index[_gid(el)] = ([tuple(v) for v in world_verts.tolist()], faces)

    return index


def _mesh_verts_faces(index: dict[str, _MeshData], element) -> _MeshData:
    """World-coord verts + triangle indices from the shared mesh index, or ([], [])."""
    return index.get(_gid(element), ([], []))


def _mesh_xy_points(index: dict[str, _MeshData], element) -> list[tuple[float, float]]:
    """Return XY vertices from element mesh in world coords, or []."""
    verts, _ = _mesh_verts_faces(index, element)
    return _unique_xy((v[0], v[1]) for v in verts)


def _tri_normal(
    verts: list[tuple[float, float, float]],
    face: tuple[int, int, int],
) -> tuple[float, float, float]:
    ax, ay, az = verts[face[0]]
    bx, by, bz = verts[face[1]]
    cx, cy, cz = verts[face[2]]
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx = uy * vz - uz * vy
    ny = uz * vx - ux * vz
    nz = ux * vy - uy * vx
    return nx, ny, nz


def _horizontal_faces(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, int, int]],
    *,
    min_nz_ratio: float = 0.85,
) -> list[tuple[int, int, int]]:
    """
    Faces whose normal is mostly vertical (floor/ceiling slabs in plan).

    Closed extrusions double-count every XY edge if all faces are used; restricting
    to horizontal faces yields the true plan outline (including concavities).
    Prefers the Z-band with larger total |projected area| (usually floor or ceiling).
    """
    bands: dict[str, list[tuple[int, int, int]]] = {"up": [], "down": []}
    areas: dict[str, float] = {"up": 0.0, "down": 0.0}
    for face in faces:
        nx, ny, nz = _tri_normal(verts, face)
        mag = (nx * nx + ny * ny + nz * nz) ** 0.5
        if mag < 1e-12:
            continue
        if abs(nz) / mag < min_nz_ratio:
            continue
        # XY projected area ~ 0.5 * |nz| component of cross product magnitude
        i, j, k = face
        ax, ay = verts[i][0], verts[i][1]
        bx, by = verts[j][0], verts[j][1]
        cx, cy = verts[k][0], verts[k][1]
        area = abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5
        key = "up" if nz > 0 else "down"
        bands[key].append(face)
        areas[key] += area
    if areas["up"] <= 0 and areas["down"] <= 0:
        return []
    return bands["up"] if areas["up"] >= areas["down"] else bands["down"]


def _boundary_edges_xy(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, int, int]],
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """Edges that appear once among projected triangles (plan silhouette boundary)."""
    counts: dict[frozenset[tuple[float, float]], int] = defaultdict(int)
    canon: dict[frozenset[tuple[float, float]], tuple[tuple[float, float], tuple[float, float]]] = {}
    for i, j, k in faces:
        tri = (_qxy(verts[i][0], verts[i][1]), _qxy(verts[j][0], verts[j][1]), _qxy(verts[k][0], verts[k][1]))
        # Degenerate in XY
        if len({tri[0], tri[1], tri[2]}) < 3:
            continue
        for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            if a == b:
                continue
            key = frozenset((a, b))
            counts[key] += 1
            canon[key] = (a, b)
    return [canon[k] for k, c in counts.items() if c == 1]


def _stitch_rings(
    edges: list[tuple[tuple[float, float], tuple[float, float]]],
) -> list[list[tuple[float, float]]]:
    adj: dict[tuple[float, float], list[tuple[float, float]]] = defaultdict(list)
    unused: set[frozenset[tuple[float, float]]] = set()
    for a, b in edges:
        if a == b:
            continue
        adj[a].append(b)
        adj[b].append(a)
        unused.add(frozenset((a, b)))

    rings: list[list[tuple[float, float]]] = []
    while unused:
        edge = next(iter(unused))
        pts = list(edge)
        start, cur = pts[0], pts[1]
        unused.discard(edge)
        ring = [start]
        prev = start
        guard = 0
        closed = False
        while guard < 200_000:
            guard += 1
            ring.append(cur)
            if cur == start and len(ring) > 2:
                ring.pop()
                closed = True
                break
            nxt = None
            for n in adj[cur]:
                if n == prev:
                    continue
                e = frozenset((cur, n))
                if e in unused:
                    nxt = n
                    break
            if nxt is None:
                # Close if start is a remaining neighbor.
                e_close = frozenset((cur, start))
                if start != prev and (e_close in unused or start in adj[cur]):
                    unused.discard(e_close)
                    cur = start
                    continue
                break
            unused.discard(frozenset((cur, nxt)))
            prev, cur = cur, nxt
        if closed and len(ring) >= 3:
            rings.append(ring)
    return rings


def _classify_exterior_and_holes(
    rings: list[list[tuple[float, float]]],
) -> tuple[list[tuple[float, float]], list[list[tuple[float, float]]]] | None:
    scored: list[tuple[float, list[tuple[float, float]]]] = []
    for ring in rings:
        area = abs(_signed_area(ring))
        if area < 1e-8 or len(ring) < 3:
            continue
        scored.append((area, ring))
    if not scored:
        return None
    scored.sort(key=lambda t: t[0], reverse=True)
    exterior = scored[0][1]
    holes: list[list[tuple[float, float]]] = []
    for area, ring in scored[1:]:
        # Representative point: average of vertices (OK for nearly convex holes).
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        if _point_in_ring(cx, cy, exterior):
            holes.append(ring)
        # else: nested exterior fragment / noise — skip for POC
    return exterior, holes


def outline_from_mesh_xy(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, int, int]],
) -> tuple[list[tuple[float, float]], list[list[tuple[float, float]]]] | None:
    """
    Build exterior + holes from a triangulated mesh projected to XY.
    Uses nearly-horizontal faces first so closed extrusions keep concave plan shapes.
    Exported for unit tests with synthetic meshes.
    """
    if len(verts) < 3 or not faces:
        return None
    use_faces = _horizontal_faces(verts, faces) or faces
    edges = _boundary_edges_xy(verts, use_faces)
    if len(edges) < 3:
        return None
    rings = _stitch_rings(edges)
    classified = _classify_exterior_and_holes(rings)
    if classified is None:
        return None
    exterior, holes = classified
    exterior = _simplify_ring(exterior)
    holes = [_simplify_ring(h) for h in holes if len(h) >= 3]
    if len(exterior) < 3:
        return None
    return exterior, holes


def _placement_xy(element) -> tuple[float, float] | None:
    if getattr(element, "ObjectPlacement", None) is None:
        return None
    try:
        matrix = ifcopenshell.util.placement.get_local_placement(element.ObjectPlacement)
        return float(matrix[0][3]), float(matrix[1][3])
    except Exception:  # noqa: BLE001
        logger.debug("no placement xy for %s", getattr(element, "GlobalId", "?"), exc_info=True)
        return None


def _placement_axes_xy(
    element,
) -> tuple[tuple[float, float], tuple[float, float], tuple[float, float]] | None:
    """
    World origin + unit local-X / local-Y projected to XY.
    For IfcDoor, local X is typically along the opening width and local Y
    through the wall (facing) — we still verify thinness when Overall* exists.
    """
    if getattr(element, "ObjectPlacement", None) is None:
        return None
    try:
        matrix = ifcopenshell.util.placement.get_local_placement(element.ObjectPlacement)
    except Exception:  # noqa: BLE001
        logger.debug("no placement axes for %s", getattr(element, "GlobalId", "?"), exc_info=True)
        return None
    ox, oy = float(matrix[0][3]), float(matrix[1][3])
    lx = (float(matrix[0][0]), float(matrix[1][0]))
    ly = (float(matrix[0][1]), float(matrix[1][1]))
    llx = math.hypot(lx[0], lx[1])
    lly = math.hypot(ly[0], ly[1])
    if llx < 1e-9 or lly < 1e-9:
        return None
    return (
        (ox, oy),
        (lx[0] / llx, lx[1] / llx),
        (ly[0] / lly, ly[1] / lly),
    )


def _rect_from_centre(
    cx: float,
    cy: float,
    along: tuple[float, float],
    through: tuple[float, float],
    half_along: float,
    half_through: float,
) -> list[Point2D]:
    ax, ay = along
    tx, ty = through
    corners = [
        (cx - ax * half_along - tx * half_through, cy - ay * half_along - ty * half_through),
        (cx + ax * half_along - tx * half_through, cy + ay * half_along - ty * half_through),
        (cx + ax * half_along + tx * half_through, cy + ay * half_along + ty * half_through),
        (cx - ax * half_along + tx * half_through, cy - ay * half_along + ty * half_through),
    ]
    return [Point2D(x=x, y=y) for x, y in corners]


def _orientation_from_hull(
    xy: list[tuple[float, float]],
) -> tuple[Point2D, list[Point2D], Point2D, list[Point2D]] | None:
    """
    From a plan point cloud: centroid, thin rectangle, unit through-wall normal,
    and leaf segment (long axis endpoints).
    """
    hull = _convex_hull(_unique_xy(xy))
    if len(hull) < 2:
        return None
    cx = sum(p[0] for p in hull) / len(hull)
    cy = sum(p[1] for p in hull) / len(hull)
    if len(hull) == 2:
        (x0, y0), (x1, y1) = hull[0], hull[1]
        along_len = math.hypot(x1 - x0, y1 - y0)
        if along_len < 1e-9:
            return None
        ax, ay = (x1 - x0) / along_len, (y1 - y0) / along_len
        nx, ny = -ay, ax
        half_along = along_len * 0.5
        half_through = 0.05
        poly = _rect_from_centre(cx, cy, (ax, ay), (nx, ny), half_along, half_through)
        return (
            Point2D(x=cx, y=cy),
            poly,
            Point2D(x=nx, y=ny),
            [Point2D(x=cx - ax * half_along, y=cy - ay * half_along),
             Point2D(x=cx + ax * half_along, y=cy + ay * half_along)],
        )

    # Rotating calipers on hull edges: thinnest direction = through-wall normal.
    best_thick = float("inf")
    best: tuple[float, float, float, float, float, float] | None = None
    n = len(hull)
    for i in range(n):
        x0, y0 = hull[i]
        x1, y1 = hull[(i + 1) % n]
        ex, ey = x1 - x0, y1 - y0
        el = math.hypot(ex, ey)
        if el < 1e-9:
            continue
        ax, ay = ex / el, ey / el
        nx, ny = -ay, ax
        projs_a = [p[0] * ax + p[1] * ay for p in hull]
        projs_n = [p[0] * nx + p[1] * ny for p in hull]
        thick = max(projs_n) - min(projs_n)
        along_span = max(projs_a) - min(projs_a)
        if thick < best_thick - 1e-9 or (
            abs(thick - best_thick) <= 1e-9 and along_span > (best[4] if best else 0)
        ):
            best_thick = thick
            best = (ax, ay, nx, ny, along_span, thick)
    if best is None:
        return None
    ax, ay, nx, ny, along_span, thick = best
    # Ensure "through" is the thinner axis.
    if along_span < thick:
        ax, ay, nx, ny = nx, ny, ax, ay
        along_span, thick = thick, along_span
    half_along = max(along_span * 0.5, 0.15)
    half_through = max(thick * 0.5, 0.04)
    poly = _rect_from_centre(cx, cy, (ax, ay), (nx, ny), half_along, half_through)
    segment = [
        Point2D(x=cx - ax * half_along, y=cy - ay * half_along),
        Point2D(x=cx + ax * half_along, y=cy + ay * half_along),
    ]
    return Point2D(x=cx, y=cy), poly, Point2D(x=nx, y=ny), segment


def _orientation_from_placement(door) -> tuple[Point2D, list[Point2D], Point2D, list[Point2D]] | None:
    axes = _placement_axes_xy(door)
    if axes is None:
        return None
    (ox, oy), lx, ly = axes
    width = getattr(door, "OverallWidth", None)
    depth = getattr(door, "OverallDepth", None)
    w = float(width) if width else 0.9
    d = float(depth) if depth else 0.12
    # Thinner Overall* axis is through-wall; prefer local Y when equal-ish.
    if d <= w:
        along, through = lx, ly
        half_along, half_through = w * 0.5, max(d * 0.5, 0.04)
    else:
        along, through = ly, lx
        half_along, half_through = d * 0.5, max(w * 0.5, 0.04)
    poly = _rect_from_centre(ox, oy, along, through, half_along, half_through)
    segment = [
        Point2D(x=ox - along[0] * half_along, y=oy - along[1] * half_along),
        Point2D(x=ox + along[0] * half_along, y=oy + along[1] * half_along),
    ]
    return Point2D(x=ox, y=oy), poly, Point2D(x=through[0], y=through[1]), segment


def _door_operation_type(door) -> str | None:
    """
    Raw IfcDoorTypeOperationEnum / IfcDoorStyleOperationEnum value (swing vs
    sliding vs folding vs ...), when the source IFC actually sets it.

    IFC2X3 carries this directly on IfcDoor; IFC4 moved it onto the door's
    IfcDoorType (accessed via the RelatingType relationship) but many IFC4
    exporters still also populate the deprecated attribute on IfcDoor itself
    — so we check both, direct attribute first.
    """
    # ifcopenshell raises (rather than AttributeError) for a schema-valid
    # attribute the entity's own IFC-file instance was written without slots
    # for (e.g. an older/sparse IFC2X3 write) — getattr's default can't catch
    # that, so guard each read explicitly.
    try:
        value = getattr(door, "OperationType", None)
    except Exception:  # noqa: BLE001
        value = None
    if value is None:
        try:
            door_type = ifcopenshell.util.element.get_type(door)
            value = getattr(door_type, "OperationType", None) if door_type is not None else None
        except Exception:  # noqa: BLE001
            value = None
    if value is None:
        return None
    text = str(value)
    if text in ("NOTDEFINED", "USERDEFINED", ""):
        return None
    return text


def _door_portal(index: dict[str, _MeshData], ifc, door) -> DoorPortal:
    gid = _gid(door)
    storey = _storey_gid(ifc, door)
    name = _name(door)
    operation_type = _door_operation_type(door)

    xy = _mesh_xy_points(index, door)
    oriented = _orientation_from_hull(xy) if xy else None
    if oriented is None:
        oriented = _orientation_from_placement(door)

    if oriented is not None:
        point, polygon, normal, segment = oriented
        method = "ifc_mesh_xy_centroid" if xy else "ifc_object_placement"
        return DoorPortal(
            global_id=gid,
            name=name,
            storey_global_id=storey,
            point=point,
            segment=segment,
            polygon=polygon,
            normal=normal,
            operation_type=operation_type,
            incomplete=False,
            method=method,
        )

    # Last resort: point only (legacy behaviour).
    if xy:
        cx = sum(p[0] for p in xy) / len(xy)
        cy = sum(p[1] for p in xy) / len(xy)
        return DoorPortal(
            global_id=gid,
            name=name,
            storey_global_id=storey,
            point=Point2D(x=cx, y=cy),
            operation_type=operation_type,
            incomplete=False,
            method="ifc_mesh_xy_centroid",
        )

    origin = _placement_xy(door)
    if origin is not None:
        return DoorPortal(
            global_id=gid,
            name=name,
            storey_global_id=storey,
            point=Point2D(x=origin[0], y=origin[1]),
            operation_type=operation_type,
            incomplete=False,
            method="ifc_object_placement",
        )

    return DoorPortal(
        global_id=gid,
        name=name,
        storey_global_id=storey,
        point=None,
        operation_type=operation_type,
        incomplete=True,
        method="unavailable",
    )


def _bbox_polygon_from_placement(element) -> list[tuple[float, float]] | None:
    origin = _placement_xy(element)
    if origin is None:
        return None
    ox, oy = origin
    width = getattr(element, "OverallWidth", None)
    depth = getattr(element, "OverallDepth", None)
    w = float(width) if width else 1.0
    d = float(depth) if depth else 1.0
    hx, hy = w / 2.0, d / 2.0
    return [
        (ox - hx, oy - hy),
        (ox + hx, oy - hy),
        (ox + hx, oy + hy),
        (ox - hx, oy + hy),
    ]


def _to_points(ring: list[tuple[float, float]]) -> list[Point2D]:
    return [Point2D(x=x, y=y) for x, y in ring]


def _space_footprint(index: dict[str, _MeshData], ifc, space) -> SpaceFootprint:
    gid = _gid(space)
    storey = _storey_gid(ifc, space)
    name = _name(space)

    verts, faces = _mesh_verts_faces(index, space)
    if verts and faces:
        outlined = outline_from_mesh_xy(verts, faces)
        if outlined is not None:
            exterior, holes = outlined
            return SpaceFootprint(
                global_id=gid,
                name=name,
                storey_global_id=storey,
                polygon=_to_points(exterior),
                holes=[_to_points(h) for h in holes],
                incomplete=False,
                method="ifc_mesh_xy_outline",
            )

    xy = _unique_xy((v[0], v[1]) for v in verts) if verts else _mesh_xy_points(index, space)
    if len(xy) >= 3:
        hull = _convex_hull(xy)
        if len(hull) >= 3:
            return SpaceFootprint(
                global_id=gid,
                name=name,
                storey_global_id=storey,
                polygon=_to_points(hull),
                holes=[],
                incomplete=False,
                method="ifc_mesh_xy_hull",
            )

    bbox = _bbox_polygon_from_placement(space)
    if bbox is not None:
        return SpaceFootprint(
            global_id=gid,
            name=name,
            storey_global_id=storey,
            polygon=_to_points(bbox),
            holes=[],
            incomplete=False,
            method="ifc_placement_bbox",
        )

    return SpaceFootprint(
        global_id=gid,
        name=name,
        storey_global_id=storey,
        polygon=[],
        holes=[],
        incomplete=True,
        method="unavailable",
    )


def _index_opening_hosts(ifc) -> dict:
    """
    Map each IfcOpeningElement to its host via IfcRelVoidsElement, built in one
    pass. Openings and their voids relationships can each number in the
    thousands on a real export, so this trades an O(openings * relationships)
    scan (one per opening) for a single O(relationships) index build.
    """
    hosts: dict = {}
    for rel in ifc.by_type("IfcRelVoidsElement"):
        opening = getattr(rel, "RelatedOpeningElement", None)
        host = getattr(rel, "RelatingBuildingElement", None)
        if opening is not None and host is not None and opening not in hosts:
            hosts[opening] = host
    return hosts


def _index_opening_fills(ifc) -> dict:
    """Map each IfcOpeningElement to (door_gid, window_gid) filling it, if any."""
    fills: dict = {}
    for rel in ifc.by_type("IfcRelFillsElement"):
        opening = getattr(rel, "RelatingOpeningElement", None)
        filling = getattr(rel, "RelatedBuildingElement", None)
        if opening is None or filling is None:
            continue
        gid = _gid(filling)
        if not gid:
            continue
        door_gid, window_gid = fills.get(opening, (None, None))
        if filling.is_a("IfcDoor"):
            door_gid = gid
        elif filling.is_a("IfcWindow"):
            window_gid = gid
        fills[opening] = (door_gid, window_gid)
    return fills


def _opening_extent(
    index: dict[str, _MeshData], opening
) -> tuple[list[Point2D], float | None, float | None]:
    """
    Plan hull and Z range of the void mesh.

    Callers use these to tell a doorway (long, thin, floor to head height) from
    a wall-profile void or a duct hole, both of which are also exported as
    ``IfcOpeningElement``.
    """
    verts, _faces = _mesh_verts_faces(index, opening)
    if not verts:
        return [], None, None
    hull_xy = _convex_hull(_unique_xy((v[0], v[1]) for v in verts))
    polygon = _to_points(hull_xy) if len(hull_xy) >= 3 else []
    zs = [v[2] for v in verts]
    return polygon, min(zs), max(zs)


def _opening_portal(
    index: dict[str, _MeshData], ifc, opening, host_by_opening: dict, fills_by_opening: dict
) -> OpeningPortal:
    host = host_by_opening.get(opening)
    door_gid, window_gid = fills_by_opening.get(opening, (None, None))
    polygon, sill_z, head_z = _opening_extent(index, opening)
    common = {
        "global_id": _gid(opening),
        "name": _name(opening),
        # Openings are rarely contained in a storey; prefer the voided wall's.
        "storey_global_id": _storey_gid(ifc, opening)
        or (_storey_gid(ifc, host) if host is not None else None),
        "filled_by_door_global_id": door_gid,
        "filled_by_window_global_id": window_gid,
        "host_global_id": _gid(host) if host is not None else None,
        "host_is_wall": host is not None and host.is_a("IfcWall"),
        "polygon": polygon,
        "sill_z": sill_z,
        "head_z": head_z,
    }

    xy = _mesh_xy_points(index, opening)
    if xy:
        cx = sum(p[0] for p in xy) / len(xy)
        cy = sum(p[1] for p in xy) / len(xy)
        return OpeningPortal(
            **common,
            point=Point2D(x=cx, y=cy),
            incomplete=False,
            method="ifc_mesh_xy_centroid",
        )

    origin = _placement_xy(opening)
    if origin is not None:
        return OpeningPortal(
            **common,
            point=Point2D(x=origin[0], y=origin[1]),
            incomplete=False,
            method="ifc_object_placement",
        )

    return OpeningPortal(
        **common,
        point=None,
        incomplete=True,
        method="unavailable",
    )


def _index_aggregated_parts(ifc) -> dict:
    """
    Map each parent product to its aggregated children (e.g. IfcStairFlight
    under IfcStair) via IfcRelAggregates, built in one pass rather than
    rescanning every relationship per stair.
    """
    parts_by_parent: dict = defaultdict(list)
    for rel in ifc.by_type("IfcRelAggregates"):
        relating = getattr(rel, "RelatingObject", None)
        if relating is None:
            continue
        parts_by_parent[relating].extend(list(getattr(rel, "RelatedObjects", None) or ()))
    return parts_by_parent


def _stair_xy_points(index: dict[str, _MeshData], stair, aggregated_parts: dict) -> list[tuple[float, float]]:
    """Collect XY verts from the stair and its flights/parts."""
    points = list(_mesh_xy_points(index, stair))
    for part in aggregated_parts.get(stair, ()):
        points.extend(_mesh_xy_points(index, part))
    return _unique_xy(points)


_FootprintT = TypeVar("_FootprintT")


def _furniture_plan_size_m(item) -> tuple[float, float] | None:
    """Return (width, depth) when both OverallWidth and OverallDepth are set.

    IfcFurnishingElement often has neither attribute (IFC4) — AttributeError or
    nulls. Callers must not invent a 1×1 m default for those; return None so the
    furniture bbox stage is skipped.
    """
    try:
        width = item.OverallWidth
        depth = item.OverallDepth
    except AttributeError:
        return None
    if width is None or depth is None:
        return None
    w, d = float(width), float(depth)
    if w <= 0 or d <= 0:
        return None
    return w, d


def _hull_or_bbox_footprint(
    gid: str,
    name: str,
    storey: str | None,
    xy: list[tuple[float, float]],
    bbox_element,
    model_cls: Callable[..., _FootprintT],
    min_area: float | None = None,
    require_dimensions: bool = False,
) -> _FootprintT | None:
    """Shared hull -> placement-bbox -> incomplete waterfall behind
    walls/stairs/furniture footprints (they differ only in how `xy` and
    `bbox_element` are sourced, and whether tiny hulls should be kept).

    `min_area`, when given (furniture only), drops a hull under that area
    outright rather than keeping it or re-approximating via the bbox guess —
    it's a *measured*, small footprint, not a missing one — and skips the
    final `incomplete=True` placeholder too: nothing here is worth flagging
    as broken data, just not worth keeping as an obstacle.

    `require_dimensions` (furniture): the shared bbox helper invents a 1×1 m
    square when OverallWidth/OverallDepth are missing. Furniture without both
    attributes must not get that invented box — skip the bbox stage instead
    (see {@link _furniture_plan_size_m}).

    That "skip the incomplete placeholder" path used to also silently
    swallow the *other* case min_area can hit: mesh tessellation AND the
    placement-bbox fallback both failing outright, with no measurement at
    all. That's not "measured and tiny", it's a real extraction failure for
    this element's IFC representation (mapped-item-only geometry, an odd
    placement chain, a Box/Axis-only representation, ...) — and it was
    indistinguishable from a wall-mounted clock being correctly ignored.
    For furniture specifically this meant a route silently stopped avoiding
    an obstacle with zero indication anything had gone wrong, on some IFC
    exporters and not others. The two are told apart below and only the
    genuine failure is logged.
    """
    if len(xy) >= 3:
        hull = _convex_hull(xy)
        if len(hull) >= 3:
            if min_area is not None and abs(_signed_area(hull)) < min_area:
                return None
            return model_cls(
                global_id=gid,
                name=name,
                storey_global_id=storey,
                polygon=_to_points(hull),
                incomplete=False,
                method="ifc_mesh_xy_hull",
            )

    if require_dimensions:
        size = _furniture_plan_size_m(bbox_element)
        if size is None:
            bbox = None
        else:
            origin = _placement_xy(bbox_element)
            if origin is None:
                bbox = None
            else:
                ox, oy = origin
                w, d = size
                hx, hy = w / 2.0, d / 2.0
                bbox = [
                    (ox - hx, oy - hy),
                    (ox + hx, oy - hy),
                    (ox + hx, oy + hy),
                    (ox - hx, oy + hy),
                ]
    else:
        bbox = _bbox_polygon_from_placement(bbox_element)
    if bbox is not None:
        return model_cls(
            global_id=gid,
            name=name,
            storey_global_id=storey,
            polygon=_to_points(bbox),
            incomplete=False,
            method="ifc_placement_bbox",
        )

    if min_area is not None:
        logger.warning(
            "%s %s (%s) has no extractable footprint on either the mesh or placement-bbox "
            "path — routing will NOT avoid it on its storey",
            model_cls.__name__,
            gid,
            name or "unnamed",
        )
        return None

    return model_cls(
        global_id=gid,
        name=name,
        storey_global_id=storey,
        polygon=[],
        incomplete=True,
        method="unavailable",
    )


def _stair_footprint(index: dict[str, _MeshData], ifc, stair, aggregated_parts: dict) -> StairFootprint:
    """Stairs stay on hull/bbox for v1 overlay (not full outline)."""
    return _hull_or_bbox_footprint(
        _gid(stair),
        _name(stair),
        _storey_gid(ifc, stair),
        _stair_xy_points(index, stair, aggregated_parts),
        stair,
        StairFootprint,
    )


def _wall_footprint(index: dict[str, _MeshData], ifc, wall) -> WallFootprint:
    """Walls use convex hull / placement bbox for strip blockage tests."""
    return _hull_or_bbox_footprint(
        _gid(wall),
        _name(wall),
        _storey_gid(ifc, wall),
        _unique_xy(_mesh_xy_points(index, wall)),
        wall,
        WallFootprint,
    )


def _mesh_z_mid(index: dict[str, _MeshData], element) -> float | None:
    """Mean world Z of the element's tessellated verts, or None if no mesh."""
    verts, _faces = _mesh_verts_faces(index, element)
    if not verts:
        return None
    return sum(v[2] for v in verts) / len(verts)


def _furniture_z_extent_m(
    index: dict[str, _MeshData], ifc, element
) -> tuple[float, float] | None:
    """World-Z span (metres) for walk-band tests.

    Prefer tessellated mesh min/max. With only ObjectPlacement, assume a short
    vertical prism so floor-rooted placement-bbox desks still intersect the
    walk band (origin alone often sits at Z = floor elevation).
    """
    verts, _faces = _mesh_verts_faces(index, element)
    if verts:
        zs = [float(v[2]) for v in verts]
        return min(zs), max(zs)
    z = _placement_z(element)
    if z is None:
        return None
    z_m = length_to_metres(ifc, z)
    if z_m is None:
        return None
    return float(z_m), float(z_m) + _PLACEMENT_ASSUMED_HEIGHT_M


def _storey_elevation_m(
    storeys: list[StoreyFootprintMeta], storey_gid: str | None
) -> float | None:
    if not storey_gid:
        return None
    for s in storeys:
        if s.global_id == storey_gid and s.elevation is not None:
            return float(s.elevation)
    return None


def _overlaps_walk_band(z_min: float, z_max: float, floor_elev_m: float) -> bool:
    band_lo = floor_elev_m + _WALK_BAND_MIN_M
    band_hi = floor_elev_m + _WALK_BAND_MAX_M
    return z_min <= band_hi and z_max >= band_lo


def _furniture_is_walk_obstacle(
    index: dict[str, _MeshData],
    ifc,
    item,
    storeys: list[StoreyFootprintMeta],
    storey_gid: str | None,
) -> bool:
    """Keep only furnishings that intersect the person-height band on the
    labeled storey. Unknown elevation or Z → keep (don't drop desks we
    cannot measure). Overhead-only geometry → False (drop).
    """
    elev = _storey_elevation_m(storeys, storey_gid)
    if elev is None:
        return True
    extent = _furniture_z_extent_m(index, ifc, item)
    if extent is None:
        return True
    return _overlaps_walk_band(extent[0], extent[1], elev)


def _placement_z(element) -> float | None:
    if getattr(element, "ObjectPlacement", None) is None:
        return None
    try:
        matrix = ifcopenshell.util.placement.get_local_placement(element.ObjectPlacement)
        return float(matrix[2][3])
    except Exception:  # noqa: BLE001
        logger.debug("no placement z for %s", getattr(element, "GlobalId", "?"), exc_info=True)
        return None


def _nearest_storey_gid(
    storeys: list[StoreyFootprintMeta], z: float | None
) -> str | None:
    """Pick the storey whose elevation is closest to ``z`` (metres)."""
    if z is None or not storeys:
        return None
    best_gid: str | None = None
    best_d = float("inf")
    for s in storeys:
        if s.elevation is None:
            continue
        d = abs(float(s.elevation) - z)
        if d < best_d:
            best_d = d
            best_gid = s.global_id
    return best_gid


def _furniture_storey(
    index: dict[str, _MeshData],
    ifc,
    item,
    storeys: list[StoreyFootprintMeta],
) -> str | None:
    """Prefer IFC spatial containment; else nearest storey by mesh/placement Z."""
    storey = _storey_gid(ifc, item)
    if storey is not None:
        return storey
    z = _mesh_z_mid(index, item)
    if z is None:
        z = _placement_z(item)
        if z is not None:
            z = length_to_metres(ifc, z)
    return _nearest_storey_gid(storeys, z)


def _furniture_footprint(
    index: dict[str, _MeshData],
    ifc,
    item,
    storeys: list[StoreyFootprintMeta],
) -> FurnitureFootprint | None:
    """Furniture plan obstacle: prefer mesh XY outline (keeps concavities —
    L-desks, U-sofas), then convex hull, then a *dimensioned* placement bbox.

    A *measured* outline/hull under `_MIN_FURNITURE_AREA_M2` is dropped rather
    than kept or re-approximated — wall art and small fixtures clutter the
    local pathfinding obstacle set without blocking a walkable route.
    Undimensioned furniture must not invent a 1×1 m square (the shared bbox
    helper's default).

    Items whose Z extent misses the storey's person-height walk band (ceiling
    fixtures, etc.) are dropped so they neither draw on the plan nor feed
    navmesh / storey-grid obstacles.
    """
    gid = _gid(item)
    name = _name(item)
    storey = _furniture_storey(index, ifc, item, storeys)
    if not _furniture_is_walk_obstacle(index, ifc, item, storeys, storey):
        return None

    verts, faces = _mesh_verts_faces(index, item)
    if verts and faces:
        outlined = outline_from_mesh_xy(verts, faces)
        if outlined is not None:
            exterior, _holes = outlined
            if abs(_signed_area(exterior)) >= _MIN_FURNITURE_AREA_M2 and len(exterior) >= 3:
                return FurnitureFootprint(
                    global_id=gid,
                    name=name,
                    storey_global_id=storey,
                    polygon=_to_points(exterior),
                    incomplete=False,
                    method="ifc_mesh_xy_outline",
                )
            # Measured but tiny — drop rather than falling through to hull/bbox.
            return None

    return _hull_or_bbox_footprint(
        gid,
        name,
        storey,
        _unique_xy((v[0], v[1]) for v in verts) if verts else _mesh_xy_points(index, item),
        item,
        FurnitureFootprint,
        min_area=_MIN_FURNITURE_AREA_M2,
        require_dimensions=True,
    )


def build_footprints(model_id: str, ifc_file_path: str) -> FootprintsDocument:
    """
    Derive footprints for spaces, doors, openings, stairs, and walls used by
    connectivity / plan overlay / strip heal.

    Element lists are gathered *before* any geometry is touched so that
    _build_mesh_index can tessellate every element this function will need
    in one shared, deduplicated pass (see its docstring) instead of each
    per-category loop below independently re-tessellating as it goes.
    """
    ifc = ifcopenshell.open(ifc_file_path)

    storeys: list[StoreyFootprintMeta] = []
    for storey in ifc.by_type("IfcBuildingStorey"):
        elev = getattr(storey, "Elevation", None)
        storeys.append(
            StoreyFootprintMeta(
                global_id=_gid(storey),
                name=_name(storey),
                # Elevation is project length units; footprints contract is metres.
                elevation=length_to_metres(ifc, float(elev) if elev is not None else None),
            )
        )

    space_elements = [s for s in ifc.by_type("IfcSpace") if _gid(s)]
    door_elements = [d for d in ifc.by_type("IfcDoor") if _gid(d)]
    opening_elements = [o for o in ifc.by_type("IfcOpeningElement") if _gid(o)]

    aggregated_parts = _index_aggregated_parts(ifc)
    stair_elements = [s for s in ifc.by_type("IfcStair") if _gid(s)]
    stair_part_elements = [part for stair in stair_elements for part in aggregated_parts.get(stair, ())]

    seen_wall: set[str] = set()
    wall_elements = []
    for wall in list(ifc.by_type("IfcWall")) + list(ifc.by_type("IfcWallStandardCase")):
        gid = _gid(wall)
        if not gid or gid in seen_wall:
            continue
        seen_wall.add(gid)
        wall_elements.append(wall)

    # IfcFurniture (IFC4+) is a subtype of IfcFurnishingElement, so this one
    # query already covers both schema versions without needing a separate,
    # schema-conditional IfcFurniture lookup.
    seen_furniture: set[str] = set()
    furniture_elements = []
    for item in ifc.by_type("IfcFurnishingElement"):
        gid = _gid(item)
        if not gid or gid in seen_furniture:
            continue
        seen_furniture.add(gid)
        furniture_elements.append(item)

    mesh_index = _build_mesh_index(
        ifc,
        [
            *space_elements,
            *door_elements,
            *opening_elements,
            *stair_elements,
            *stair_part_elements,
            *wall_elements,
            *furniture_elements,
        ],
    )

    spaces = [_space_footprint(mesh_index, ifc, space) for space in space_elements]
    doors = [_door_portal(mesh_index, ifc, door) for door in door_elements]

    host_by_opening = _index_opening_hosts(ifc)
    fills_by_opening = _index_opening_fills(ifc)
    openings = [
        _opening_portal(mesh_index, ifc, opening, host_by_opening, fills_by_opening)
        for opening in opening_elements
    ]

    stairs = [_stair_footprint(mesh_index, ifc, stair, aggregated_parts) for stair in stair_elements]
    walls = [_wall_footprint(mesh_index, ifc, wall) for wall in wall_elements]

    furniture: list[FurnitureFootprint] = []
    for item in furniture_elements:
        footprint = _furniture_footprint(mesh_index, ifc, item, storeys)
        if footprint is not None:
            furniture.append(footprint)

    return FootprintsDocument(
        model_id=model_id,
        storeys=storeys,
        spaces=spaces,
        doors=doors,
        openings=openings,
        stairs=stairs,
        walls=walls,
        furniture=furniture,
    )
