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
Door portals use mesh XY centroid, else ObjectPlacement translation.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.placement

from app.schemas.footprints import (
    DoorPortal,
    FootprintsDocument,
    Point2D,
    SpaceFootprint,
    StairFootprint,
    StoreyFootprintMeta,
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


def _door_portal(ifc, door) -> DoorPortal:
    gid = _gid(door)
    storey = _storey_gid(ifc, door)
    name = _name(door)

    xy = _mesh_xy_points(door)
    if xy:
        cx = sum(p[0] for p in xy) / len(xy)
        cy = sum(p[1] for p in xy) / len(xy)
        return DoorPortal(
            global_id=gid,
            name=name,
            storey_global_id=storey,
            point=Point2D(x=cx, y=cy),
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
            incomplete=False,
            method="ifc_object_placement",
        )

    return DoorPortal(
        global_id=gid,
        name=name,
        storey_global_id=storey,
        point=None,
        incomplete=True,
        method="unavailable",
    )


def _aggregated_parts(ifc, parent) -> list:
    """Child products aggregated under parent (e.g. IfcStairFlight under IfcStair)."""
    parts: list = []
    for rel in ifc.by_type("IfcRelAggregates"):
        relating = getattr(rel, "RelatingObject", None)
        if relating != parent:
            continue
        parts.extend(list(getattr(rel, "RelatedObjects", None) or ()))
    return parts


def _stair_xy_points(ifc, stair) -> list[tuple[float, float]]:
    """Collect XY verts from the stair and its flights/parts."""
    points = list(_mesh_xy_points(stair))
    for part in _aggregated_parts(ifc, stair):
        points.extend(_mesh_xy_points(part))
    return _unique_xy(points)


def _stair_footprint(ifc, stair) -> StairFootprint:
    """Stairs stay on hull/bbox for v1 overlay (not full outline)."""
    gid = _gid(stair)
    storey = _storey_gid(ifc, stair)
    name = _name(stair)

    xy = _stair_xy_points(ifc, stair)
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


def build_footprints(model_id: str, ifc_file_path: str) -> FootprintsDocument:
    """
    Derive footprints for every IfcSpace / IfcDoor / IfcStair that enters the
    connectivity graph (spaces + doors for path; stairs for plan overlay).
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

    stairs: list[StairFootprint] = []
    for stair in ifc.by_type("IfcStair"):
        if not _gid(stair):
            continue
        stairs.append(_stair_footprint(ifc, stair))

    return FootprintsDocument(
        model_id=model_id,
        storeys=storeys,
        spaces=spaces,
        doors=doors,
        stairs=stairs,
    )
