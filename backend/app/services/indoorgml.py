"""
Parse OGC IndoorGML (core module) directly into the same FootprintsDocument +
ConnectivityGraph contract the IFC pipeline produces, so every downstream
consumer (navmesh, routing, floorplan/graph rendering) works completely
unchanged — IndoorGML just becomes a second producer of that contract.

IndoorGML already gives us, natively, the two things IFC needs "geometry
rules" healing to approximate:
- CellSpace geometry -> SpaceFootprint polygons directly (no outline-from-
  mesh reconstruction needed, unlike IFC's ifc_mesh_xy_outline pipeline).
- State/Transition -> the connectivity graph directly (no adjacency
  inference needed) -- this is explicit, authoritative data, the same tier
  "ifc_rel_space_boundary" occupies for IFC (see IFC_BASELINE_METHODS).

Namespace handling: elements are matched by LOCAL name only, ignoring the
exact xmlns URI. IndoorGML has real version/vendor variance in the wild
(1.0, 1.0.3, draft 2.0, ADE extensions) and this project has no reference
file to validate byte-for-byte against one specific schema revision --
local-name matching is deliberately permissive (best-effort, never crash on
a structurally-reasonable file) rather than strict-validate-then-reject,
the same spirit as the IFC extractor's hull/bbox/incomplete waterfall.

Storey assignment: IndoorGML's Core module has no first-class "storey"
entity the way IFC has IfcBuildingStorey. Cells are clustered into
synthetic storeys by their geometry's elevation (simple gap-based 1D
clustering on sorted Z), not by SpaceLayer membership -- a SpaceLayer is a
graph *theme* (Topographic/Sensor/etc.) in the spec, not guaranteed to mean
"one floor", so elevation is the more defensible signal without a real
sample file to validate either heuristic against.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

from app.schemas.entities import (
    DoorEntity,
    EntitiesExtract,
    SpaceEntity,
    StoreyEntity,
)
from app.schemas.footprints import (
    DoorPortal,
    FootprintsDocument,
    Point2D,
    SpaceFootprint,
    StoreyFootprintMeta,
)
from app.schemas.graph import ConnectivityGraph, GraphEdge, GraphNode
from app.services.footprints import _convex_hull

# Storeys separated by less than this (metres) are treated as the same
# floor -- absorbs minor slab-thickness/measurement noise within one level.
_STOREY_GAP_M = 1.5


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _find_all(elem: ET.Element, name: str) -> list[ET.Element]:
    """Every descendant (not elem itself) whose local tag name matches."""
    return [c for c in elem.iter() if c is not elem and _local(c.tag) == name]


def _find_first(elem: ET.Element, name: str) -> ET.Element | None:
    for c in elem.iter():
        if c is not elem and _local(c.tag) == name:
            return c
    return None


def _attr(elem: ET.Element, name: str) -> str | None:
    for k, v in elem.attrib.items():
        if _local(k) == name:
            return v
    return None


def _gml_id(elem: ET.Element) -> str | None:
    return _attr(elem, "id")


def _gml_name(elem: ET.Element) -> str | None:
    for c in elem:
        if _local(c.tag) == "name" and c.text and c.text.strip():
            return c.text.strip()
    return None


def _xlink_href(elem: ET.Element) -> str | None:
    href = _attr(elem, "href")
    return href.lstrip("#") if href else None


def _duality_target(elem: ET.Element) -> str | None:
    duality = _find_first(elem, "duality")
    return _xlink_href(duality) if duality is not None else None


def _connects_targets(transition: ET.Element) -> list[str]:
    out = []
    for c in transition:
        if _local(c.tag) == "connects":
            href = _xlink_href(c)
            if href:
                out.append(href)
    return out


def _parse_pos_list(text: str, dim: int) -> list[tuple[float, float, float]]:
    nums = [float(t) for t in text.split()]
    out: list[tuple[float, float, float]] = []
    step = max(dim, 2)
    for i in range(0, len(nums) - step + 1, step):
        x, y = nums[i], nums[i + 1]
        z = nums[i + 2] if step >= 3 else 0.0
        out.append((x, y, z))
    return out


def _srs_dimension(elem: ET.Element, default: int) -> int:
    raw = _attr(elem, "srsDimension")
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _coords_in(elem: ET.Element, dim_hint: int) -> list[tuple[float, float, float]]:
    """Every coordinate triple found anywhere under `elem`: gml:posList
    (single flattened list) or repeated gml:pos (one point each) — GML
    allows either form and real exports use both."""
    out: list[tuple[float, float, float]] = []
    for pos_list in _find_all(elem, "posList"):
        if pos_list.text:
            dim = _srs_dimension(pos_list, dim_hint)
            out.extend(_parse_pos_list(pos_list.text, dim))
    for pos in _find_all(elem, "pos"):
        if not pos.text:
            continue
        nums = [float(t) for t in pos.text.split()]
        if len(nums) >= 3:
            out.append((nums[0], nums[1], nums[2]))
        elif len(nums) == 2:
            out.append((nums[0], nums[1], 0.0))
    return out


def _polygon_xy(geom_elem: ET.Element, dim_hint: int) -> list[tuple[float, float]] | None:
    """First named ring's XY, or (for a multi-surface Solid) the convex hull
    across every ring's vertices — there's no reliable "pick the floor face"
    signal without full BREP-normal analysis, so a hull is the honest
    fallback tier here, same role it plays for walls/furniture in the IFC
    extractor when a precise outline isn't available."""
    rings = _find_all(geom_elem, "LinearRing")
    if not rings:
        return None
    if len(rings) == 1:
        coords = _coords_in(rings[0], dim_hint)
        xy = [(x, y) for x, y, _z in coords]
        # GML rings are closed (first point repeated as the last) — drop the
        # duplicate so the stored polygon is the minimal vertex set, same
        # convention the IFC extractor's hull/outline methods already use.
        if len(xy) > 1 and xy[0] == xy[-1]:
            xy = xy[:-1]
        if len(xy) >= 3:
            return xy
        return None
    all_xy = [(x, y) for ring in rings for x, y, _z in _coords_in(ring, dim_hint)]
    if len(all_xy) < 3:
        return None
    return _convex_hull(all_xy)


def _min_z(geom_elem: ET.Element, dim_hint: int) -> float | None:
    zs = [z for _x, _y, z in _coords_in(geom_elem, dim_hint)]
    return min(zs) if zs else None


def _centroid(points: list[tuple[float, float]]) -> tuple[float, float] | None:
    if not points:
        return None
    n = len(points)
    return (sum(p[0] for p in points) / n, sum(p[1] for p in points) / n)


def _geometry_and_elevation(elem: ET.Element) -> tuple[list[tuple[float, float]] | None, float | None]:
    """CellSpace/CellSpaceBoundary carry geometry under either Geometry2D or
    Geometry3D — the parent element name is the only reliable dimension
    hint (an explicit srsDimension, when present, overrides it per-posList)."""
    for name, dim in (("Geometry2D", 2), ("Geometry3D", 3)):
        geom = _find_first(elem, name)
        if geom is None:
            continue
        return _polygon_xy(geom, dim), _min_z(geom, dim)
    return None, None


def _cluster_storeys(elevations: list[float]) -> list[float]:
    """Sorted unique elevations, gap-clustered — returns one representative
    (the cluster's minimum) per storey, ordered low to high."""
    if not elevations:
        return [0.0]
    ordered = sorted(set(elevations))
    clusters: list[list[float]] = [[ordered[0]]]
    for z in ordered[1:]:
        if z - clusters[-1][-1] > _STOREY_GAP_M:
            clusters.append([z])
        else:
            clusters[-1].append(z)
    return [c[0] for c in clusters]


def _storey_key_for(z: float, cluster_mins: list[float]) -> float:
    """Which cluster (by its representative min) a given elevation belongs
    to — the last cluster whose min is <= z."""
    best = cluster_mins[0]
    for m in cluster_mins:
        if m <= z + 1e-6:
            best = m
        else:
            break
    return best


def parse_indoorgml(
    model_id: str, xml_path: str
) -> tuple[EntitiesExtract, FootprintsDocument, ConnectivityGraph]:
    tree = ET.parse(xml_path)
    root = tree.getroot()

    cellspaces = _find_all(root, "CellSpace")
    boundaries = _find_all(root, "CellSpaceBoundary")
    states = _find_all(root, "State")
    transitions = _find_all(root, "Transition")

    # --- CellSpace geometry, name, elevation ---
    cell_gid_by_elem_id: dict[str, str] = {}  # gml:id -> stable global_id (same value here)
    cell_name: dict[str, str] = {}
    cell_polygon: dict[str, list[tuple[float, float]]] = {}
    cell_elevation: dict[str, float] = {}
    for cs in cellspaces:
        gid = _gml_id(cs)
        if not gid:
            continue
        cell_gid_by_elem_id[gid] = gid
        cell_name[gid] = _gml_name(cs) or gid
        poly, elev = _geometry_and_elevation(cs)
        if poly and len(poly) >= 3:
            cell_polygon[gid] = poly
        if elev is not None:
            cell_elevation[gid] = elev

    cluster_mins = _cluster_storeys(list(cell_elevation.values()))
    cell_storey: dict[str, str] = {}
    for gid in cell_polygon:
        z = cell_elevation.get(gid, cluster_mins[0])
        key = _storey_key_for(z, cluster_mins)
        cell_storey[gid] = f"storey_{key:.3f}"

    storeys = [
        StoreyFootprintMeta(global_id=f"storey_{m:.3f}", name=f"Level {i + 1}", elevation=m)
        for i, m in enumerate(cluster_mins)
    ]

    # --- State: duality -> which CellSpace each graph node represents ---
    state_cellspace: dict[str, str] = {}
    for state in states:
        sid = _gml_id(state)
        target = _duality_target(state)
        if sid and target:
            state_cellspace[sid] = target

    # --- CellSpaceBoundary geometry (for door portal points) ---
    boundary_geometry: dict[str, list[tuple[float, float]]] = {}
    boundary_name: dict[str, str] = {}
    for cb in boundaries:
        bid = _gml_id(cb)
        if not bid:
            continue
        boundary_name[bid] = _gml_name(cb) or bid
        for name, dim in (("Geometry2D", 2), ("Geometry3D", 3)):
            geom = _find_first(cb, name)
            if geom is None:
                continue
            coords = _coords_in(geom, dim)
            if coords:
                boundary_geometry[bid] = [(x, y) for x, y, _z in coords]
            break

    # --- Transition: connects two States -> two CellSpaces; duality -> a boundary ---
    spaces: list[SpaceFootprint] = []
    for gid, poly in cell_polygon.items():
        spaces.append(
            SpaceFootprint(
                global_id=gid,
                name=cell_name.get(gid, gid),
                storey_global_id=cell_storey.get(gid),
                polygon=[Point2D(x=p[0], y=p[1]) for p in poly],
                incomplete=False,
                method="indoorgml_geometry",
            )
        )

    doors: list[DoorPortal] = []
    graph_nodes: list[GraphNode] = [
        GraphNode(
            id=f"space:{gid}",
            kind="space",
            global_id=gid,
            name=cell_name.get(gid, gid),
            storey_global_id=cell_storey.get(gid),
        )
        for gid in cell_polygon
    ]
    graph_edges: list[GraphEdge] = []

    seen_doors: set[str] = set()
    for i, transition in enumerate(transitions):
        state_ids = _connects_targets(transition)
        if len(state_ids) != 2:
            continue
        space_a = state_cellspace.get(state_ids[0])
        space_b = state_cellspace.get(state_ids[1])
        if not space_a or not space_b or space_a not in cell_polygon or space_b not in cell_polygon:
            continue

        boundary_id = _duality_target(transition)
        door_gid = boundary_id or f"transition_{_gml_id(transition) or i}"
        storey = cell_storey.get(space_a) or cell_storey.get(space_b)

        point: tuple[float, float] | None = None
        method: str = "indoorgml_transition_midpoint"
        if boundary_id and boundary_id in boundary_geometry:
            point = _centroid(boundary_geometry[boundary_id])
            method = "indoorgml_boundary_centroid"
        if point is None:
            centre_a = _centroid(cell_polygon[space_a])
            centre_b = _centroid(cell_polygon[space_b])
            if centre_a and centre_b:
                point = ((centre_a[0] + centre_b[0]) / 2, (centre_a[1] + centre_b[1]) / 2)

        if door_gid not in seen_doors:
            seen_doors.add(door_gid)
            doors.append(
                DoorPortal(
                    global_id=door_gid,
                    name=boundary_name.get(boundary_id or "", "Door"),
                    storey_global_id=storey,
                    point=Point2D(x=point[0], y=point[1]) if point else None,
                    segment=[],
                    incomplete=point is None,
                    method=method if point else "unavailable",
                )
            )
            graph_nodes.append(
                GraphNode(
                    id=f"door:{door_gid}",
                    kind="door",
                    global_id=door_gid,
                    name=boundary_name.get(boundary_id or "", "Door"),
                    storey_global_id=storey,
                )
            )

        portal = Point2D(x=point[0], y=point[1]) if point else None
        graph_edges.append(
            GraphEdge(
                id=f"space_door:{space_a}:{door_gid}:indoorgml",
                kind="space_door",
                source=f"space:{space_a}",
                target=f"door:{door_gid}",
                global_id=door_gid,
                method="indoorgml_transition",
                inferred=False,
                portal=portal,
            )
        )
        graph_edges.append(
            GraphEdge(
                id=f"space_door:{space_b}:{door_gid}:indoorgml",
                kind="space_door",
                source=f"door:{door_gid}",
                target=f"space:{space_b}",
                global_id=door_gid,
                method="indoorgml_transition",
                inferred=False,
                portal=portal,
            )
        )

    entities = EntitiesExtract(
        model_id=model_id,
        storeys=[StoreyEntity(global_id=s.global_id, name=s.name, elevation=s.elevation) for s in storeys],
        spaces=[
            SpaceEntity(global_id=s.global_id, name=s.name, storey_global_id=s.storey_global_id)
            for s in spaces
        ],
        doors=[
            DoorEntity(global_id=d.global_id, name=d.name, storey_global_id=d.storey_global_id)
            for d in doors
        ],
        stairs=[],
        lifts=[],
        exit_candidates=[],
    )

    footprints = FootprintsDocument(
        model_id=model_id,
        storeys=storeys,
        spaces=spaces,
        doors=doors,
        openings=[],
        stairs=[],
        walls=[],
        furniture=[],
    )

    graph = ConnectivityGraph(
        model_id=model_id,
        variant="ifc",
        nodes=graph_nodes,
        edges=graph_edges,
    )

    return entities, footprints, graph
