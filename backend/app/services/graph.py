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

    # Doors without space boundaries: do NOT link to every space on the storey
    # (that caused tens of thousands of edges). Leave them as isolated portal
    # nodes until a better adjacency heuristic is available.

    # Weak same-storey circulation: chain spaces on each storey by name so
    # rooms remain reachable when IFC space boundaries are missing.
    for storey, space_ids in spaces_by_storey.items():
        if not storey or len(space_ids) < 2:
            continue
        ordered = sorted(space_ids, key=lambda sid: (nodes[sid].name or nodes[sid].global_id).lower())
        for left, right in zip(ordered, ordered[1:]):
            edge_id = f"space_chain:{nodes[left].global_id}:{nodes[right].global_id}"
            add_edge(
                GraphEdge(
                    id=edge_id,
                    kind="space_door",
                    source=left,
                    target=right,
                    method="same_storey_fallback",
                    bidirectional=True,
                )
            )

    storeys_with_spaces = [s for s in spaces_by_storey.keys() if s]
    vertical_nodes = [n for n in nodes.values() if n.kind in ("stair", "lift")]

    # Star topology through the vertical hub: every space on a storey links to
    # each stair/lift so multi-storey routes do not depend on a single hub room.
    for vertical in vertical_nodes:
        for storey in storeys_with_spaces:
            for space_id in spaces_by_storey.get(storey) or []:
                edge_id = (
                    f"vertical:{vertical.global_id}:{nodes[space_id].global_id}"
                )
                add_edge(
                    GraphEdge(
                        id=edge_id,
                        kind="vertical",
                        source=space_id,
                        target=vertical.id,
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
