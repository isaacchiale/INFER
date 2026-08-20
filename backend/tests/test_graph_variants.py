from app.schemas.footprints import (
    DoorPortal,
    FootprintsDocument,
    Point2D,
    SpaceFootprint,
    StairFootprint,
)
from app.schemas.graph import ConnectivityGraph, GraphEdge, GraphNode
from app.services.graph_geometry import build_geometry_graph
from app.services.graph_topologic import (
    TopologicUnavailableError,
    build_topologic_graph,
    merge_topologic_edges,
    topologic_available,
)


def _box_space(gid: str, storey: str, x0: float, y0: float, x1: float, y1: float) -> SpaceFootprint:
    return SpaceFootprint(
        global_id=gid,
        name=gid,
        storey_global_id=storey,
        polygon=[
            Point2D(x=x0, y=y0),
            Point2D(x=x1, y=y0),
            Point2D(x=x1, y=y1),
            Point2D(x=x0, y=y1),
        ],
        incomplete=False,
        method="ifc_placement_bbox",
    )


def test_geometry_heals_door_and_stair():
    ifc = ConnectivityGraph(
        model_id="m1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
            GraphNode(id="stair:S", kind="stair", global_id="S", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", 0, 0, 4, 4),
            _box_space("B", "L1", 5, 0, 9, 4),
        ],
        doors=[
            DoorPortal(
                global_id="D",
                name="D",
                storey_global_id="L1",
                point=Point2D(x=4.5, y=2),
                segment=[],
                incomplete=False,
                method="ifc_object_placement",
            )
        ],
        stairs=[
            StairFootprint(
                global_id="S",
                name="S",
                storey_global_id="L1",
                polygon=[
                    Point2D(x=1, y=1),
                    Point2D(x=2, y=1),
                    Point2D(x=2, y=2),
                    Point2D(x=1, y=2),
                ],
                incomplete=False,
                method="ifc_placement_bbox",
            )
        ],
    )

    geo = build_geometry_graph(ifc, footprints)
    assert geo.variant == "geometry"
    assert any(e.inferred and e.method == "geom_door_space" for e in geo.edges)
    assert any(e.inferred and e.method == "geom_stair_space" for e in geo.edges)
    door_edges = [e for e in geo.edges if e.method == "geom_door_space"]
    linked_spaces = set()
    for e in door_edges:
        linked_spaces.add(e.source if e.source.startswith("space:") else e.target)
    assert "space:A" in linked_spaces and "space:B" in linked_spaces

    stair_spaces = set()
    for e in geo.edges:
        if e.method != "geom_stair_space":
            continue
        stair_spaces.add(e.source if e.source.startswith("space:") else e.target)
    assert stair_spaces == {"space:A"}  # hull inside A only — not B


def test_door_inside_room_still_links_nearby_corridor():
    """
    Door point inside room A (dist 0) but corridor B only ~0.3 m away must
    still get space–door–space (containing-only preference used to drop B).
    """
    ifc = ConnectivityGraph(
        model_id="m_door",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[],
    )
    # Room 0..4×0..4; corridor 4.3..8×0..4 (gap 0.3 m). Door inside room near wall.
    footprints = FootprintsDocument(
        model_id="m_door",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", 0, 0, 4, 4),
            _box_space("B", "L1", 4.3, 0, 8, 4),
        ],
        doors=[
            DoorPortal(
                global_id="D",
                name="D",
                storey_global_id="L1",
                point=Point2D(x=3.9, y=2),  # inside A; ~0.4 m from B
                segment=[],
                incomplete=False,
                method="ifc_object_placement",
            )
        ],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    linked = {
        (e.source if e.source.startswith("space:") else e.target)
        for e in geo.edges
        if e.method == "geom_door_space"
    }
    assert linked == {"space:A", "space:B"}


def test_door_heal_keeps_only_nearest_two_spaces():
    """Within 1 m, only the opposing nearest pair is linked (not a same-side third)."""
    ifc = ConnectivityGraph(
        model_id="m_door3",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="space:C", kind="space", global_id="C", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[],
    )
    # Door on the shared edge between A (left) and B (right). C is further right — same
    # side as B relative to the door, so A+B pass "between", A+C also opposite but farther.
    footprints = FootprintsDocument(
        model_id="m_door3",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", -4, -1, 0, 1),
            _box_space("B", "L1", 0, -1, 2, 1),
            _box_space("C", "L1", 0.4, -1, 3, 1),
        ],
        doors=[
            DoorPortal(
                global_id="D",
                name="D",
                storey_global_id="L1",
                point=Point2D(x=0, y=0),
                segment=[],
                incomplete=False,
                method="ifc_object_placement",
            )
        ],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    linked = {
        (e.source if e.source.startswith("space:") else e.target)
        for e in geo.edges
        if e.method == "geom_door_space"
    }
    assert linked == {"space:A", "space:B"}
    assert "space:C" not in linked


def test_door_heal_rejects_same_side_pair():
    """Two spaces on the same side of the door → only nearest one-sided link."""
    ifc = ConnectivityGraph(
        model_id="m_door_side",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[],
    )
    # Both rooms to the right of the door — contacts are not opposite.
    footprints = FootprintsDocument(
        model_id="m_door_side",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", 0.2, -1, 2, 1),
            _box_space("B", "L1", 0.5, -1, 3, 1),
        ],
        doors=[
            DoorPortal(
                global_id="D",
                name="D",
                storey_global_id="L1",
                point=Point2D(x=0, y=0),
                segment=[],
                incomplete=False,
                method="ifc_object_placement",
            )
        ],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    linked = {
        (e.source if e.source.startswith("space:") else e.target)
        for e in geo.edges
        if e.method == "geom_door_space"
    }
    assert linked == {"space:A"}


def test_door_heal_connects_when_inside_both_spaces():
    """Overlapping footprints both containing D → still link the pair."""
    ifc = ConnectivityGraph(
        model_id="m_door_overlap",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m_door_overlap",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", -2, -2, 2, 2),
            _box_space("B", "L1", -1, -1, 3, 3),
        ],
        doors=[
            DoorPortal(
                global_id="D",
                name="D",
                storey_global_id="L1",
                point=Point2D(x=0, y=0),
                segment=[],
                incomplete=False,
                method="ifc_object_placement",
            )
        ],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    linked = {
        (e.source if e.source.startswith("space:") else e.target)
        for e in geo.edges
        if e.method == "geom_door_space"
    }
    assert linked == {"space:A", "space:B"}


def test_stair_links_own_and_next_storey_only():
    """IfcStair on L1 → intersecting IfcSpaces on L1 + L2 only (not L3)."""
    ifc = ConnectivityGraph(
        model_id="m2",
        variant="ifc",
        nodes=[
            GraphNode(id="space:L1a", kind="space", global_id="L1a", storey_global_id="L1"),
            GraphNode(id="space:L2a", kind="space", global_id="L2a", storey_global_id="L2"),
            GraphNode(id="space:L2far", kind="space", global_id="L2far", storey_global_id="L2"),
            GraphNode(id="space:L3a", kind="space", global_id="L3a", storey_global_id="L3"),
            GraphNode(id="stair:S", kind="stair", global_id="S", storey_global_id="L1"),
        ],
        edges=[],
    )
    hull = [
        Point2D(x=0, y=0),
        Point2D(x=2, y=0),
        Point2D(x=2, y=2),
        Point2D(x=0, y=2),
    ]
    footprints = FootprintsDocument(
        model_id="m2",
        storeys=[
            {"global_id": "L1", "name": "L1", "elevation": 0.0},
            {"global_id": "L2", "name": "L2", "elevation": 3.0},
            {"global_id": "L3", "name": "L3", "elevation": 6.0},
        ],
        spaces=[
            _box_space("L1a", "L1", 0, 0, 2, 2),
            _box_space("L2a", "L2", 0, 0, 2, 2),  # same shaft XY
            _box_space("L2far", "L2", 10, 10, 12, 12),
            _box_space("L3a", "L3", 0, 0, 2, 2),  # same XY but two levels above
        ],
        doors=[],
        stairs=[
            StairFootprint(
                global_id="S",
                name="S",
                storey_global_id="L1",
                polygon=hull,
                incomplete=False,
                method="ifc_mesh_xy_hull",
            )
        ],
    )
    geo = build_geometry_graph(ifc, footprints)
    stair_spaces = {
        (e.source if e.source.startswith("space:") else e.target)
        for e in geo.edges
        if e.method == "geom_stair_space"
    }
    assert stair_spaces == {"space:L1a", "space:L2a"}
    assert "space:L2far" not in stair_spaces
    assert "space:L3a" not in stair_spaces


def test_stair_on_l3_links_l3_and_l4_not_l5():
    """IfcStair belonging on Level 3 → Level 3 + Level 4 IfcSpaces only."""
    ifc = ConnectivityGraph(
        model_id="m3",
        variant="ifc",
        nodes=[
            GraphNode(id="space:L3a", kind="space", global_id="L3a", storey_global_id="L3"),
            GraphNode(id="space:L4a", kind="space", global_id="L4a", storey_global_id="L4"),
            GraphNode(id="space:L5a", kind="space", global_id="L5a", storey_global_id="L5"),
            GraphNode(id="stair:S", kind="stair", global_id="S", storey_global_id="L3"),
        ],
        edges=[],
    )
    hull = [
        Point2D(x=0, y=0),
        Point2D(x=2, y=0),
        Point2D(x=2, y=2),
        Point2D(x=0, y=2),
    ]
    footprints = FootprintsDocument(
        model_id="m3",
        storeys=[
            {"global_id": "L1", "name": "L1", "elevation": 0.0},
            {"global_id": "L2", "name": "L2", "elevation": 3.0},
            {"global_id": "L3", "name": "L3", "elevation": 6.0},
            {"global_id": "L4", "name": "L4", "elevation": 9.0},
            {"global_id": "L5", "name": "L5", "elevation": 12.0},
        ],
        spaces=[
            _box_space("L3a", "L3", 0, 0, 2, 2),
            _box_space("L4a", "L4", 0, 0, 2, 2),
            _box_space("L5a", "L5", 0, 0, 2, 2),
        ],
        doors=[],
        stairs=[
            StairFootprint(
                global_id="S",
                name="S",
                storey_global_id="L3",
                polygon=hull,
                incomplete=False,
                method="ifc_mesh_xy_hull",
            )
        ],
    )
    geo = build_geometry_graph(ifc, footprints)
    stair_spaces = {
        (e.source if e.source.startswith("space:") else e.target)
        for e in geo.edges
        if e.method == "geom_stair_space"
    }
    assert stair_spaces == {"space:L3a", "space:L4a"}
    assert "space:L5a" not in stair_spaces


def test_stair_picks_one_space_per_storey_by_overlap_then_ratio():
    """
    Per storey: max ∩ area; on equal ∩, prefer stair_area/space_area closer to 1.
    Stair 2x2=4m²; A fully overlaps and is 4m²; B fully overlaps and is 5m² → A.
    Partial C on same storey with smaller ∩ loses to A.
    """
    ifc = ConnectivityGraph(
        model_id="m4",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="space:C", kind="space", global_id="C", storey_global_id="L1"),
            GraphNode(id="stair:S", kind="stair", global_id="S", storey_global_id="L1"),
        ],
        edges=[],
    )
    # Stair hull: 0..2 x 0..2 → area 4
    hull = [
        Point2D(x=0, y=0),
        Point2D(x=2, y=0),
        Point2D(x=2, y=2),
        Point2D(x=0, y=2),
    ]
    footprints = FootprintsDocument(
        model_id="m4",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", 0, 0, 2, 2),  # ∩=4, ratio=1.0
            _box_space("B", "L1", 0, 0, 2.5, 2),  # ∩=4, ratio=4/5=0.8
            _box_space("C", "L1", 1.5, 0, 3, 2),  # ∩=1 only
        ],
        doors=[],
        stairs=[
            StairFootprint(
                global_id="S",
                name="S",
                storey_global_id="L1",
                polygon=hull,
                incomplete=False,
                method="ifc_mesh_xy_hull",
            )
        ],
    )
    geo = build_geometry_graph(ifc, footprints)
    stair_spaces = {
        (e.source if e.source.startswith("space:") else e.target)
        for e in geo.edges
        if e.method == "geom_stair_space"
    }
    assert stair_spaces == {"space:A"}


def test_stair_ratio_tiebreak_prefers_closer_to_100_percent():
    """Equal ∩ area: stair 4m², C=2m² (r=2), D=3m² (r≈1.33) → pick D."""
    ifc = ConnectivityGraph(
        model_id="m5",
        variant="ifc",
        nodes=[
            GraphNode(id="space:C", kind="space", global_id="C", storey_global_id="L1"),
            GraphNode(id="space:D", kind="space", global_id="D", storey_global_id="L1"),
            GraphNode(id="stair:S", kind="stair", global_id="S", storey_global_id="L1"),
        ],
        edges=[],
    )
    # Stair 0..2×0..2 = 4. Both have ∩=2; C area=2, D area=3 → D closer to 100%.
    hull = [
        Point2D(x=0, y=0),
        Point2D(x=2, y=0),
        Point2D(x=2, y=2),
        Point2D(x=0, y=2),
    ]
    footprints = FootprintsDocument(
        model_id="m5",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("C", "L1", 0, 0, 2, 1),  # area 2, ∩=2
            _box_space("D", "L1", -0.5, 0, 2.5, 1),  # area 3, ∩=2
        ],
        doors=[],
        stairs=[
            StairFootprint(
                global_id="S",
                name="S",
                storey_global_id="L1",
                polygon=hull,
                incomplete=False,
                method="ifc_mesh_xy_hull",
            )
        ],
    )
    geo = build_geometry_graph(ifc, footprints)
    stair_spaces = {
        (e.source if e.source.startswith("space:") else e.target)
        for e in geo.edges
        if e.method == "geom_stair_space"
    }
    assert stair_spaces == {"space:D"}

def test_topologic_unavailable_without_package():
    if topologic_available():
        return
    ifc = ConnectivityGraph(model_id="m", nodes=[], edges=[])
    try:
        build_topologic_graph("m", "/tmp/x.ifc", ifc)
        raise AssertionError("expected TopologicUnavailableError")
    except TopologicUnavailableError as exc:
        assert "TopologicPy" in str(exc)


def test_merge_topologic_edges_marks_inferred():
    ifc = ConnectivityGraph(
        model_id="m",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A"),
            GraphNode(id="space:B", kind="space", global_id="B"),
            GraphNode(id="door:x", kind="door", global_id="x"),
        ],
        edges=[
            GraphEdge(
                id="e0",
                kind="space_door",
                source="space:A",
                target="door:x",
                method="ifc_rel_space_boundary",
                inferred=False,
            )
        ],
    )
    out = merge_topologic_edges(ifc, [("A", "B")])
    assert out.variant == "topologic"
    inferred = [e for e in out.edges if e.inferred]
    assert len(inferred) == 1
    assert inferred[0].method == "topologicpy_adjacency"
    assert inferred[0].kind == "space_space"


def test_nested_parent_flagged_when_space_contains_children():
    """Parent footprint containing smaller rooms → nested_parent on geometry graph."""
    ifc = ConnectivityGraph(
        model_id="m1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:PARENT", kind="space", global_id="PARENT", storey_global_id="L1"),
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="space:OTHER", kind="space", global_id="OTHER", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("PARENT", "L1", 0, 0, 20, 10),
            _box_space("A", "L1", 1, 1, 5, 5),
            _box_space("B", "L1", 12, 1, 18, 8),
            _box_space("OTHER", "L1", 30, 0, 34, 4),
        ],
        doors=[],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    by_id = {n.id: n for n in geo.nodes}
    assert by_id["space:PARENT"].nested_parent is True
    assert by_id["space:A"].nested_parent is False
    assert by_id["space:B"].nested_parent is False
    assert by_id["space:OTHER"].nested_parent is False


def test_adjacent_rooms_are_not_nested_parents():
    """Side-by-side rooms must not flag each other as nested parents."""
    ifc = ConnectivityGraph(
        model_id="m1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", 0, 0, 4, 4),
            _box_space("B", "L1", 5, 0, 9, 4),
        ],
        doors=[],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    assert all(not n.nested_parent for n in geo.nodes)
