from __future__ import annotations

import networkx as nx

from app.schemas.graph import ConnectivityGraph
from app.schemas.route import RouteResult


class RoutingError(Exception):
    pass


def to_networkx(
    graph: ConnectivityGraph,
    *,
    blocked_node_ids: set[str] | None = None,
    blocked_edge_ids: set[str] | None = None,
) -> nx.Graph:
    blocked_nodes = blocked_node_ids or set()
    blocked_edges = blocked_edge_ids or set()

    g = nx.Graph()
    for node in graph.nodes:
        if node.id in blocked_nodes:
            continue
        g.add_node(
            node.id,
            kind=node.kind,
            global_id=node.global_id,
            name=node.name,
            storey_global_id=node.storey_global_id,
        )

    for edge in graph.edges:
        if edge.id in blocked_edges:
            continue
        if edge.source in blocked_nodes or edge.target in blocked_nodes:
            continue
        if edge.source not in g or edge.target not in g:
            continue
        g.add_edge(
            edge.source,
            edge.target,
            id=edge.id,
            kind=edge.kind,
            method=edge.method,
            weight=1.0,
        )

    return g


def find_shortest_path(
    graph: ConnectivityGraph,
    origin_node_id: str,
    destination_node_id: str,
    *,
    blocked_node_ids: list[str] | None = None,
    blocked_edge_ids: list[str] | None = None,
) -> RouteResult:
    blocked_nodes = set(blocked_node_ids or [])
    blocked_edges = set(blocked_edge_ids or [])

    if origin_node_id in blocked_nodes or destination_node_id in blocked_nodes:
        return RouteResult(
            found=False,
            origin_node_id=origin_node_id,
            destination_node_id=destination_node_id,
            blocked_node_ids=sorted(blocked_nodes),
            blocked_edge_ids=sorted(blocked_edges),
            message="Origin or destination is blocked.",
        )

    node_ids = {n.id for n in graph.nodes}
    if origin_node_id not in node_ids or destination_node_id not in node_ids:
        raise RoutingError("Origin or destination node id not found in graph.")

    g = to_networkx(
        graph,
        blocked_node_ids=blocked_nodes,
        blocked_edge_ids=blocked_edges,
    )

    try:
        path = nx.shortest_path(
            g, source=origin_node_id, target=destination_node_id, weight="weight"
        )
    except nx.NetworkXNoPath:
        return RouteResult(
            found=False,
            origin_node_id=origin_node_id,
            destination_node_id=destination_node_id,
            blocked_node_ids=sorted(blocked_nodes),
            blocked_edge_ids=sorted(blocked_edges),
            message="No path exists.",
        )
    except nx.NodeNotFound:
        return RouteResult(
            found=False,
            origin_node_id=origin_node_id,
            destination_node_id=destination_node_id,
            blocked_node_ids=sorted(blocked_nodes),
            blocked_edge_ids=sorted(blocked_edges),
            message="Origin or destination missing after applying blockages.",
        )

    edge_ids: list[str] = []
    for a, b in zip(path, path[1:]):
        data = g.get_edge_data(a, b) or {}
        edge_ids.append(str(data.get("id", f"{a}|{b}")))

    return RouteResult(
        found=True,
        origin_node_id=origin_node_id,
        destination_node_id=destination_node_id,
        node_ids=path,
        edge_ids=edge_ids,
        hops=max(len(path) - 1, 0),
        blocked_node_ids=sorted(blocked_nodes),
        blocked_edge_ids=sorted(blocked_edges),
        message="Shortest path found.",
    )
