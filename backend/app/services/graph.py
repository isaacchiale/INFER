from __future__ import annotations

import ifcopenshell
import ifcopenshell.util.element

from app.schemas.graph import ConnectivityGraph, GraphEdge, GraphNode


def _gid(element) -> str:
    return getattr(element, "GlobalId", None) or ""


def _name(element) -> str:
    return (getattr(element, "Name", None) or getattr(element, "ObjectType", None) or "").strip()


def _storey_gid(ifc, element) -> str | None:
    container = ifcopenshell.util.element.get_container(element)
    if container is not None and container.is_a("IfcBuildingStorey"):
        return _gid(container)

    # Spaces are often aggregated under storeys rather than "contained".
    for rel in ifc.by_type("IfcRelAggregates"):
        relating = getattr(rel, "RelatingObject", None)
        related = getattr(rel, "RelatedObjects", None) or ()
        if relating is None or not relating.is_a("IfcBuildingStorey"):
            continue
        if element in related:
            return _gid(relating)

    for rel in ifc.by_type("IfcRelContainedInSpatialStructure"):
        structure = getattr(rel, "RelatingStructure", None)
        related = getattr(rel, "RelatedElements", None) or ()
        if structure is None or not structure.is_a("IfcBuildingStorey"):
            continue
        if element in related:
            return _gid(structure)

    return None


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

    spaces_by_storey: dict[str | None, list[str]] = {}
    for space in ifc.by_type("IfcSpace"):
        gid = _gid(space)
        if not gid:
            continue
        storey = _storey_gid(ifc, space)
        node = GraphNode(
            id=_node_id("space", gid),
            kind="space",
            global_id=gid,
            name=_name(space),
            storey_global_id=storey,
        )
        add_node(node)
        spaces_by_storey.setdefault(storey, []).append(node.id)

    doors: list[tuple[str, str | None]] = []
    for door in ifc.by_type("IfcDoor"):
        gid = _gid(door)
        if not gid:
            continue
        storey = _storey_gid(ifc, door)
        add_node(
            GraphNode(
                id=_node_id("door", gid),
                kind="door",
                global_id=gid,
                name=_name(door),
                storey_global_id=storey,
            )
        )
        doors.append((gid, storey))

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

    boundary_linked_doors: set[str] = set()
    for rel in ifc.by_type("IfcRelSpaceBoundary"):
        space = getattr(rel, "RelatingSpace", None)
        element = getattr(rel, "RelatedBuildingElement", None)
        if space is None or element is None:
            continue
        if not element.is_a("IfcDoor"):
            continue
        space_gid = _gid(space)
        door_gid = _gid(element)
        if not space_gid or not door_gid:
            continue
        space_id = _node_id("space", space_gid)
        door_id = _node_id("door", door_gid)
        if space_id not in nodes or door_id not in nodes:
            continue
        edge_id = f"space_door:{space_gid}:{door_gid}:boundary"
        add_edge(
            GraphEdge(
                id=edge_id,
                kind="space_door",
                source=space_id,
                target=door_id,
                global_id=_gid(rel) or None,
                method="ifc_rel_space_boundary",
                bidirectional=True,
            )
        )
        boundary_linked_doors.add(door_gid)

    for door_gid, storey in doors:
        if door_gid in boundary_linked_doors:
            continue
        door_id = _node_id("door", door_gid)
        for space_id in spaces_by_storey.get(storey, []):
            space_gid = nodes[space_id].global_id
            edge_id = f"space_door:{space_gid}:{door_gid}:fallback"
            add_edge(
                GraphEdge(
                    id=edge_id,
                    kind="space_door",
                    source=space_id,
                    target=door_id,
                    global_id=door_gid,
                    method="same_storey_fallback",
                    bidirectional=True,
                )
            )

    storeys_with_spaces = [s for s in spaces_by_storey.keys() if s]
    vertical_nodes = [
        n for n in nodes.values() if n.kind in ("stair", "lift")
    ]
    for vertical in vertical_nodes:
        # Star-link spaces across storeys through the vertical connector.
        for i, storey_a in enumerate(storeys_with_spaces):
            for storey_b in storeys_with_spaces[i + 1 :]:
                for space_a in spaces_by_storey.get(storey_a, []):
                    for space_b in spaces_by_storey.get(storey_b, []):
                        edge_id = (
                            f"vertical:{vertical.global_id}:"
                            f"{nodes[space_a].global_id}:{nodes[space_b].global_id}"
                        )
                        add_edge(
                            GraphEdge(
                                id=edge_id,
                                kind="vertical",
                                source=space_a,
                                target=space_b,
                                global_id=vertical.global_id,
                                method="vertical_storey_link",
                                bidirectional=True,
                            )
                        )

    return ConnectivityGraph(
        model_id=model_id,
        nodes=list(nodes.values()),
        edges=list(edges.values()),
    )
