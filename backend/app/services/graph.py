from __future__ import annotations

import weakref

import ifcopenshell
import ifcopenshell.util.element

from app.schemas.graph import ConnectivityGraph, GraphEdge, GraphNode


def _gid(element) -> str:
    return getattr(element, "GlobalId", None) or ""


def _name(element) -> str:
    return (getattr(element, "Name", None) or getattr(element, "ObjectType", None) or "").strip()


# Per-ifc-file index of "element -> storey" via IfcRelAggregates /
# IfcRelContainedInSpatialStructure, built once instead of rescanning every
# relationship in the model on every _storey_gid call (this is called once
# per space/door/stair/lift/wall/opening across graph.py and ingest/ifc.py).
# Keyed by the ifc file object itself via a weak-key map so it's naturally
# evicted once that file is garbage collected — no manual cache lifecycle.
_storey_relations_cache: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def _storey_relations(ifc) -> tuple[dict, dict]:
    cached = _storey_relations_cache.get(ifc)
    if cached is not None:
        return cached

    # Spaces are often aggregated under storeys rather than "contained".
    aggregates: dict = {}
    for rel in ifc.by_type("IfcRelAggregates"):
        relating = getattr(rel, "RelatingObject", None)
        if relating is None or not relating.is_a("IfcBuildingStorey"):
            continue
        for related in getattr(rel, "RelatedObjects", None) or ():
            aggregates.setdefault(related, relating)

    contained: dict = {}
    for rel in ifc.by_type("IfcRelContainedInSpatialStructure"):
        structure = getattr(rel, "RelatingStructure", None)
        if structure is None or not structure.is_a("IfcBuildingStorey"):
            continue
        for related in getattr(rel, "RelatedElements", None) or ():
            contained.setdefault(related, structure)

    result = (aggregates, contained)
    _storey_relations_cache[ifc] = result
    return result


def _storey_gid(ifc, element) -> str | None:
    container = ifcopenshell.util.element.get_container(element)
    if container is not None and container.is_a("IfcBuildingStorey"):
        return _gid(container)

    aggregates, contained = _storey_relations(ifc)
    storey = aggregates.get(element) or contained.get(element)
    return _gid(storey) if storey is not None else None


def _node_id(kind: str, global_id: str) -> str:
    return f"{kind}:{global_id}"


def build_connectivity_graph(model_id: str, ifc_file_path: str) -> ConnectivityGraph:
    ifc = ifcopenshell.open(ifc_file_path)

    nodes: dict[str, GraphNode] = {}
    edges: dict[str, GraphEdge] = {}

    def add_node(node: GraphNode) -> None:
        nodes[node.id] = node

    def add_edge(edge: GraphEdge) -> None:
        edges[edge.id] = edge

    for space in ifc.by_type("IfcSpace"):
        gid = _gid(space)
        if not gid:
            continue
        storey = _storey_gid(ifc, space)
        add_node(
            GraphNode(
                id=_node_id("space", gid),
                kind="space",
                global_id=gid,
                name=_name(space),
                storey_global_id=storey,
            )
        )

    for door in ifc.by_type("IfcDoor"):
        gid = _gid(door)
        if not gid:
            continue
        add_node(
            GraphNode(
                id=_node_id("door", gid),
                kind="door",
                global_id=gid,
                name=_name(door),
                storey_global_id=_storey_gid(ifc, door),
            )
        )

    for stair in ifc.by_type("IfcStair"):
        gid = _gid(stair)
        if not gid:
            continue
        add_node(
            GraphNode(
                id=_node_id("stair", gid),
                kind="stair",
                global_id=gid,
                name=_name(stair),
                storey_global_id=_storey_gid(ifc, stair),
            )
        )

    for lift in ifc.by_type("IfcTransportElement"):
        gid = _gid(lift)
        if not gid:
            continue
        add_node(
            GraphNode(
                id=_node_id("lift", gid),
                kind="lift",
                global_id=gid,
                name=_name(lift),
                storey_global_id=_storey_gid(ifc, lift),
            )
        )

    # Strict IFC layer only: space ↔ portal via IfcRelSpaceBoundary.
    # No name-chain room adjacency and no stair/lift star topology.
    # Geometry fallbacks (e.g. topologicpy) belong in a later layer.
    for rel in ifc.by_type("IfcRelSpaceBoundary"):
        space = getattr(rel, "RelatingSpace", None)
        element = getattr(rel, "RelatedBuildingElement", None)
        if space is None or element is None:
            continue

        space_gid = _gid(space)
        element_gid = _gid(element)
        if not space_gid or not element_gid:
            continue

        space_id = _node_id("space", space_gid)
        if space_id not in nodes:
            continue

        if element.is_a("IfcDoor"):
            portal_id = _node_id("door", element_gid)
            if portal_id not in nodes:
                continue
            add_edge(
                GraphEdge(
                    id=f"space_door:{space_gid}:{element_gid}:boundary",
                    kind="space_door",
                    source=space_id,
                    target=portal_id,
                    global_id=_gid(rel) or None,
                    method="ifc_rel_space_boundary",
                    bidirectional=True,
                    inferred=False,
                )
            )
        elif element.is_a("IfcStair"):
            portal_id = _node_id("stair", element_gid)
            if portal_id not in nodes:
                continue
            add_edge(
                GraphEdge(
                    id=f"vertical:{element_gid}:{space_gid}:boundary",
                    kind="vertical",
                    source=space_id,
                    target=portal_id,
                    global_id=_gid(rel) or None,
                    method="ifc_rel_space_boundary",
                    bidirectional=True,
                    inferred=False,
                )
            )
        elif element.is_a("IfcTransportElement"):
            portal_id = _node_id("lift", element_gid)
            if portal_id not in nodes:
                continue
            add_edge(
                GraphEdge(
                    id=f"vertical:{element_gid}:{space_gid}:boundary",
                    kind="vertical",
                    source=space_id,
                    target=portal_id,
                    global_id=_gid(rel) or None,
                    method="ifc_rel_space_boundary",
                    bidirectional=True,
                    inferred=False,
                )
            )

    return ConnectivityGraph(
        model_id=model_id,
        variant="ifc",
        nodes=list(nodes.values()),
        edges=list(edges.values()),
    )
