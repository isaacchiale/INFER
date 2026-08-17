"""
Build 2D footprints for every space (and door portal) that enters the navigation graph.

Method (documented for task 2.1):
1. Prefer ifcopenshell.geom.create_shape → collect mesh vertices → project to XY →
   convex hull as the space polygon (good enough POC footprint; not a full BREP outline).
2. Fallback: local placement origin ± OverallWidth/Depth (or a small default bbox).
3. If neither works → incomplete=True, empty polygon (do not invent wall-cutting coords).

Door portals use mesh XY centroid, else ObjectPlacement translation.
"""

from __future__ import annotations

from typing import Iterable

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.placement

from app.schemas.footprints import (
    DoorPortal,
    FootprintsDocument,
    Point2D,
    SpaceFootprint,
    StoreyFootprintMeta,
)
from app.services.graph import _gid, _name, _storey_gid
from app.services.ifc_units import length_to_metres


def _unique_xy(points: Iterable[tuple[float, float]], tol: float = 1e-6) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for x, y in points:
        if any(abs(x - ox) <= tol and abs(y - oy) <= tol for ox, oy in out):
            continue
        out.append((x, y))
    return out


def _cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


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


def _mesh_xy_points(element) -> list[tuple[float, float]]:
    """Return XY vertices from element mesh in world coords, or []."""
    try:
        settings = ifcopenshell.geom.settings()
        settings.set(settings.USE_WORLD_COORDS, True)
        shape = ifcopenshell.geom.create_shape(settings, element)
        verts = shape.geometry.verts  # flat xyz triples
        points: list[tuple[float, float]] = []
        for i in range(0, len(verts), 3):
            points.append((float(verts[i]), float(verts[i + 1])))
        return _unique_xy(points)
    except Exception:  # noqa: BLE001 - geom failures are common on sparse IFCs
        return []


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


def _space_footprint(ifc, space) -> SpaceFootprint:
    gid = _gid(space)
    storey = _storey_gid(ifc, space)
    name = _name(space)

    xy = _mesh_xy_points(space)
    if len(xy) >= 3:
        hull = _convex_hull(xy)
        if len(hull) >= 3:
            return SpaceFootprint(
                global_id=gid,
                name=name,
                storey_global_id=storey,
                polygon=[Point2D(x=x, y=y) for x, y in hull],
                incomplete=False,
                method="ifc_mesh_xy_hull",
            )

    bbox = _bbox_polygon_from_placement(space)
    if bbox is not None:
        return SpaceFootprint(
            global_id=gid,
            name=name,
            storey_global_id=storey,
            polygon=[Point2D(x=x, y=y) for x, y in bbox],
            incomplete=False,
            method="ifc_placement_bbox",
        )

    return SpaceFootprint(
        global_id=gid,
        name=name,
        storey_global_id=storey,
        polygon=[],
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


def build_footprints(model_id: str, ifc_file_path: str) -> FootprintsDocument:
    """
    Derive footprints for every IfcSpace / IfcDoor that enters the connectivity graph
    (same population as graph space/door nodes).
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

    return FootprintsDocument(
        model_id=model_id,
        storeys=storeys,
        spaces=spaces,
        doors=doors,
    )
