from app.schemas.graph import ConnectivityGraph, GraphEdge, GraphNode
from app.services.routing import find_shortest_path


def _toy_graph() -> ConnectivityGraph:
    return ConnectivityGraph(
        model_id="toy",
        nodes=[
            GraphNode(id="space:a", kind="space", global_id="a", name="A", storey_global_id="L1"),
            GraphNode(id="door:d", kind="door", global_id="d", name="D", storey_global_id="L1"),
            GraphNode(id="space:b", kind="space", global_id="b", name="B", storey_global_id="L1"),
            GraphNode(id="stair:s", kind="stair", global_id="s", name="S", storey_global_id="L1"),
            GraphNode(id="space:c", kind="space", global_id="c", name="C", storey_global_id="L2"),
        ],
        edges=[
            GraphEdge(
                id="e1",
                kind="space_door",
                source="space:a",
                target="door:d",
                method="ifc_rel_space_boundary",
            ),
            GraphEdge(
                id="e2",
                kind="space_door",
                source="space:b",
                target="door:d",
                method="ifc_rel_space_boundary",
            ),
            GraphEdge(
                id="e3",
                kind="vertical",
                source="space:b",
                target="stair:s",
                method="vertical_storey_link",
                global_id="s",
            ),
            GraphEdge(
                id="e4",
                kind="vertical",
                source="stair:s",
                target="space:c",
                method="vertical_storey_link",
                global_id="s",
            ),
        ],
    )


def test_shortest_path_hops():
    result = find_shortest_path(_toy_graph(), "space:a", "space:c")
    assert result.found is True
    assert result.node_ids[0] == "space:a"
    assert result.node_ids[-1] == "space:c"
    assert "stair:s" in result.node_ids
    assert result.hops == 4


def test_blocked_stair_cuts_path():
    result = find_shortest_path(
        _toy_graph(),
        "space:a",
        "space:c",
        blocked_node_ids=["stair:s"],
    )
    assert result.found is False
