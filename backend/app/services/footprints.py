"""
Build 2D footprints for every space (and door portal) that enters the navigation graph.

Method (spaces):
1. Prefer ifcopenshell.geom mesh → keep nearly-horizontal faces (floor/ceiling) →
   project to XY → boundary-edge stitch → exterior + holes (ifc_mesh_xy_outline).
   Full 3D meshes are not used for boundary edges: floor+ceiling would double-count
   every plan edge and force a convex-hull fallback.
2. Fallback: convex hull of mesh XY (ifc_mesh_xy_hull).
3. Fallback: local placement origin ± OverallWidth/Depth (ifc_placement_bbox).
4. If neither works → incomplete=True, empty polygon.

Stairs stay on convex hull / bbox for plan overlay (v1).
Door portals use mesh plan hull (thin rectangle + facing normal) when possible,
else ObjectPlacement axes / OverallWidth×OverallDepth, else a point only.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable
import math

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.placement

from app.schemas.footprints import (
    DoorPortal,
    FootprintsDocument,
    OpeningPortal,
    Point2D,
    SpaceFootprint,
    StairFootprint,
    StoreyFootprintMeta,
    WallFootprint,
)
from app.services.graph import _gid, _name, _storey_gid
from app.services.ifc_units import length_to_metres

# Quantize XY when matching mesh edges (metres).
_XY_NDIGITS = 4
# Douglas–Peucker simplify epsilon (metres) for noisy outlines.
_SIMPLIFY_EPS_M = 0.05


def _unique_xy(points: Iterable[tuple[float, float]], tol: float = 1e-6) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for x, y in points:
        if any(abs(x - ox) <= tol and abs(y - oy) <= tol for ox, oy in out):
            continue
        out.append((x, y))
    return out


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


def _mesh_verts_faces(element) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    """World-coord verts + triangle indices, or ([], [])."""
    try:
        settings = ifcopenshell.geom.settings()
        settings.set(settings.USE_WORLD_COORDS, True)
        shape = ifcopenshell.geom.create_shape(settings, element)
        raw = shape.geometry.verts
        verts: list[tuple[float, float, float]] = []
        for i in range(0, len(raw), 3):
            verts.append((float(raw[i]), float(raw[i + 1]), float(raw[i + 2])))
        faces_raw = shape.geometry.faces
        faces: list[tuple[int, int, int]] = []
        for i in range(0, len(faces_raw), 3):
            faces.append((int(faces_raw[i]), int(faces_raw[i + 1]), int(faces_raw[i + 2])))
        return verts, faces
    except Exception:  # noqa: BLE001
        return [], []


def _mesh_xy_points(element) -> list[tuple[float, float]]:
    """Return XY vertices from element mesh in world coords, or []."""
    verts, _ = _mesh_verts_faces(element)
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


def _door_portal(ifc, door) -> DoorPortal:
    gid = _gid(door)
    storey = _storey_gid(ifc, door)
    name = _name(door)
    operation_type = _door_operation_type(door)

    xy = _mesh_xy_points(door)
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


def _space_footprint(ifc, space) -> SpaceFootprint:
    gid = _gid(space)
    storey = _storey_gid(ifc, space)
    name = _name(space)

    verts, faces = _mesh_verts_faces(space)
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

    xy = _unique_xy((v[0], v[1]) for v in verts) if verts else _mesh_xy_points(space)
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


def _opening_extent(opening) -> tuple[list[Point2D], float | None, float | None]:
    """
    Plan hull and Z range of the void mesh.

    Callers use these to tell a doorway (long, thin, floor to head height) from
    a wall-profile void or a duct hole, both of which are also exported as
    ``IfcOpeningElement``.
    """
    verts, _faces = _mesh_verts_faces(opening)
    if not verts:
        return [], None, None
    hull_xy = _convex_hull(_unique_xy((v[0], v[1]) for v in verts))
    polygon = _to_points(hull_xy) if len(hull_xy) >= 3 else []
    zs = [v[2] for v in verts]
    return polygon, min(zs), max(zs)


def _opening_portal(
    ifc, opening, host_by_opening: dict, fills_by_opening: dict
) -> OpeningPortal:
    host = host_by_opening.get(opening)
    door_gid, window_gid = fills_by_opening.get(opening, (None, None))
    polygon, sill_z, head_z = _opening_extent(opening)
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

    xy = _mesh_xy_points(opening)
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


def _stair_xy_points(ifc, stair, aggregated_parts: dict) -> list[tuple[float, float]]:
    """Collect XY verts from the stair and its flights/parts."""
    points = list(_mesh_xy_points(stair))
    for part in aggregated_parts.get(stair, ()):
        points.extend(_mesh_xy_points(part))
    return _unique_xy(points)


def _stair_footprint(ifc, stair, aggregated_parts: dict) -> StairFootprint:
    """Stairs stay on hull/bbox for v1 overlay (not full outline)."""
    gid = _gid(stair)
    storey = _storey_gid(ifc, stair)
    name = _name(stair)

    xy = _stair_xy_points(ifc, stair, aggregated_parts)
    if len(xy) >= 3:
        hull = _convex_hull(xy)
        if len(hull) >= 3:
            return StairFootprint(
                global_id=gid,
                name=name,
                storey_global_id=storey,
                polygon=_to_points(hull),
                incomplete=False,
                method="ifc_mesh_xy_hull",
            )

    bbox = _bbox_polygon_from_placement(stair)
    if bbox is not None:
        return StairFootprint(
            global_id=gid,
            name=name,
            storey_global_id=storey,
            polygon=_to_points(bbox),
            incomplete=False,
            method="ifc_placement_bbox",
        )

    return StairFootprint(
        global_id=gid,
        name=name,
        storey_global_id=storey,
        polygon=[],
        incomplete=True,
        method="unavailable",
    )


def _wall_footprint(ifc, wall) -> WallFootprint:
    """Walls use convex hull / placement bbox for strip blockage tests."""
    gid = _gid(wall)
    storey = _storey_gid(ifc, wall)
    name = _name(wall)

    xy = _unique_xy(_mesh_xy_points(wall))
    if len(xy) >= 3:
        hull = _convex_hull(xy)
        if len(hull) >= 3:
            return WallFootprint(
                global_id=gid,
                name=name,
                storey_global_id=storey,
                polygon=_to_points(hull),
                incomplete=False,
                method="ifc_mesh_xy_hull",
            )

    bbox = _bbox_polygon_from_placement(wall)
    if bbox is not None:
        return WallFootprint(
            global_id=gid,
            name=name,
            storey_global_id=storey,
            polygon=_to_points(bbox),
            incomplete=False,
            method="ifc_placement_bbox",
        )

    return WallFootprint(
        global_id=gid,
        name=name,
        storey_global_id=storey,
        polygon=[],
        incomplete=True,
        method="unavailable",
    )


def build_footprints(model_id: str, ifc_file_path: str) -> FootprintsDocument:
    """
    Derive footprints for spaces, doors, openings, stairs, and walls used by
    connectivity / plan overlay / strip heal.
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

    spaces: list[SpaceFootprint] = []
    for space in ifc.by_type("IfcSpace"):
        if not _gid(space):
            continue
        spaces.append(_space_footprint(ifc, space))

    doors: list[DoorPortal] = []
    for door in ifc.by_type("IfcDoor"):
        if not _gid(door):
            continue
        doors.append(_door_portal(ifc, door))

    openings: list[OpeningPortal] = []
    host_by_opening = _index_opening_hosts(ifc)
    fills_by_opening = _index_opening_fills(ifc)
    for opening in ifc.by_type("IfcOpeningElement"):
        if not _gid(opening):
            continue
        openings.append(_opening_portal(ifc, opening, host_by_opening, fills_by_opening))

    stairs: list[StairFootprint] = []
    aggregated_parts = _index_aggregated_parts(ifc)
    for stair in ifc.by_type("IfcStair"):
        if not _gid(stair):
            continue
        stairs.append(_stair_footprint(ifc, stair, aggregated_parts))

    walls: list[WallFootprint] = []
    seen_wall: set[str] = set()
    for wall in list(ifc.by_type("IfcWall")) + list(ifc.by_type("IfcWallStandardCase")):
        gid = _gid(wall)
        if not gid or gid in seen_wall:
            continue
        seen_wall.add(gid)
        walls.append(_wall_footprint(ifc, wall))

    return FootprintsDocument(
        model_id=model_id,
        storeys=storeys,
        spaces=spaces,
        doors=doors,
        openings=openings,
        stairs=stairs,
        walls=walls,
    )
