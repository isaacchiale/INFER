from app.schemas.footprints import (
    DoorPortal,
    FootprintsDocument,
    OpeningPortal,
    Point2D,
    SpaceFootprint,
    StairFootprint,
    WallFootprint,
)
from app.schemas.graph import ConnectivityGraph, GraphEdge, GraphNode
from app.services.graph_geometry import (
    MIN_CLEAR_SPAN_M,
    _frontage_strip_samples,
    _max_clear_span_m,
    _point_hits_wall,
    build_geometry_graph,
    reheal_geometry_graph,
)
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


def _box_wall(gid: str, storey: str, x0: float, y0: float, x1: float, y1: float) -> WallFootprint:
    return WallFootprint(
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


def _oriented_door(
    gid: str,
    storey: str,
    x: float,
    y: float,
    *,
    nx: float,
    ny: float,
    half_along: float = 0.45,
    half_through: float = 0.06,
) -> DoorPortal:
    """Thin rectangle door: normal (nx,ny) is through-wall facing."""
    L = (nx * nx + ny * ny) ** 0.5
    nx, ny = nx / L, ny / L
    ax, ay = -ny, nx  # along leaf
    poly = [
        Point2D(x=x - ax * half_along - nx * half_through, y=y - ay * half_along - ny * half_through),
        Point2D(x=x + ax * half_along - nx * half_through, y=y + ay * half_along - ny * half_through),
        Point2D(x=x + ax * half_along + nx * half_through, y=y + ay * half_along + ny * half_through),
        Point2D(x=x - ax * half_along + nx * half_through, y=y - ay * half_along + ny * half_through),
    ]
    return DoorPortal(
        global_id=gid,
        name=gid,
        storey_global_id=storey,
        point=Point2D(x=x, y=y),
        segment=[
            Point2D(x=x - ax * half_along, y=y - ay * half_along),
            Point2D(x=x + ax * half_along, y=y + ay * half_along),
        ],
        polygon=poly,
        normal=Point2D(x=nx, y=ny),
        incomplete=False,
        method="ifc_object_placement",
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


def test_door_heal_skips_when_ifc_already_has_two_links():
    """≥2 IFC space_door links → no geometry top-up for that door."""
    ifc = ConnectivityGraph(
        model_id="m_door_ifc2",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="space:C", kind="space", global_id="C", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[
            GraphEdge(
                id="eA",
                kind="space_door",
                source="space:A",
                target="door:D",
                method="ifc_rel_space_boundary",
                inferred=False,
            ),
            GraphEdge(
                id="eB",
                kind="space_door",
                source="space:B",
                target="door:D",
                method="ifc_rel_space_boundary",
                inferred=False,
            ),
        ],
    )
    footprints = FootprintsDocument(
        model_id="m_door_ifc2",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", -4, -1, 0, 1),
            _box_space("B", "L1", 0, -1, 2, 1),
            _box_space("C", "L1", -1, 1.2, 1, 3),  # would pass geom with A if healed
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
    assert not any(e.method == "geom_door_space" for e in geo.edges)
    space_links = {
        e.source if e.source.startswith("space:") else e.target
        for e in geo.edges
        if e.kind == "space_door"
    }
    assert space_links == {"space:A", "space:B"}


def test_door_heal_ifc_one_link_partners_only_against_ifc_space():
    """
    IFC linked to Red only: second side must pass between-math with Red
    (not Green↔Blue), and be the closest such candidate.
    """
    ifc = ConnectivityGraph(
        model_id="m_door_ifc1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:RED", kind="space", global_id="RED", storey_global_id="L1"),
            GraphNode(id="space:GREEN", kind="space", global_id="GREEN", storey_global_id="L1"),
            GraphNode(id="space:BLUE", kind="space", global_id="BLUE", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[
            GraphEdge(
                id="eR",
                kind="space_door",
                source="space:RED",
                target="door:D",
                method="ifc_rel_space_boundary",
                inferred=False,
            ),
        ],
    )
    # Door on shared vertical wall between RED (left) and GREEN (right).
    # BLUE is further right — opposite RED but farther than GREEN.
    footprints = FootprintsDocument(
        model_id="m_door_ifc1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("RED", "L1", -4, -1, 0, 1),
            _box_space("GREEN", "L1", 0, -1, 2, 1),
            _box_space("BLUE", "L1", 0.5, -1, 3, 1),
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
    geom = [
        e.source if e.source.startswith("space:") else e.target
        for e in geo.edges
        if e.method == "geom_door_space"
    ]
    assert geom == ["space:GREEN"]
    all_links = {
        e.source if e.source.startswith("space:") else e.target
        for e in geo.edges
        if e.kind == "space_door"
    }
    assert all_links == {"space:RED", "space:GREEN"}
    assert "space:BLUE" not in all_links


def test_oriented_door_raycast_links_both_sides():
    """±normal rays hit A and B; corner room C is not along the normal."""
    ifc = ConnectivityGraph(
        model_id="m_orient",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="space:C", kind="space", global_id="C", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m_orient",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", -4, -1, -0.05, 1),
            _box_space("B", "L1", 0.05, -1, 4, 1),
            _box_space("C", "L1", -1, 1.2, 1, 3),  # above — not on ±X
        ],
        doors=[_oriented_door("D", "L1", 0, 0, nx=1, ny=0)],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    linked = {
        e.source if e.source.startswith("space:") else e.target
        for e in geo.edges
        if e.method == "geom_door_space"
    }
    assert linked == {"space:A", "space:B"}
    assert "space:C" not in linked


def test_oriented_door_inside_room_still_hits_corridor():
    """Door inside A near the wall; +normal ray reaches corridor B."""
    ifc = ConnectivityGraph(
        model_id="m_orient_in",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m_orient_in",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", 0, 0, 4, 4),
            _box_space("B", "L1", 4.3, 0, 8, 4),
        ],
        doors=[_oriented_door("D", "L1", 3.9, 2, nx=1, ny=0)],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    linked = {
        e.source if e.source.startswith("space:") else e.target
        for e in geo.edges
        if e.method == "geom_door_space"
    }
    assert linked == {"space:A", "space:B"}


def test_oriented_door_same_side_only_nearest():
    """Both rooms on +normal side → only the first ray hit."""
    ifc = ConnectivityGraph(
        model_id="m_orient_side",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m_orient_side",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", 0.2, -1, 2, 1),
            _box_space("B", "L1", 0.5, -1, 3, 1),
        ],
        doors=[_oriented_door("D", "L1", 0, 0, nx=1, ny=0)],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    linked = {
        e.source if e.source.startswith("space:") else e.target
        for e in geo.edges
        if e.method == "geom_door_space"
    }
    assert linked == {"space:A"}


def test_oriented_door_inflate_excludes_far_room():
    """Room beyond the 0.5 m inflate box is not a ray candidate."""
    ifc = ConnectivityGraph(
        model_id="m_orient_far",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:FAR", kind="space", global_id="FAR", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[],
    )
    # FAR starts 2 m away — outside 0.5 m inflate around a ~0.1 m thick door.
    footprints = FootprintsDocument(
        model_id="m_orient_far",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", -4, -1, -0.05, 1),
            _box_space("FAR", "L1", 2.0, -1, 4, 1),
        ],
        doors=[_oriented_door("D", "L1", 0, 0, nx=1, ny=0)],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    linked = {
        e.source if e.source.startswith("space:") else e.target
        for e in geo.edges
        if e.method == "geom_door_space"
    }
    assert linked == {"space:A"}
    assert "space:FAR" not in linked


def test_oriented_door_ifc_one_link_picks_other_ray():
    """IFC→RED; oriented ray toward GREEN adds only GREEN, not BLUE beyond it."""
    ifc = ConnectivityGraph(
        model_id="m_orient_ifc1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:RED", kind="space", global_id="RED", storey_global_id="L1"),
            GraphNode(id="space:GREEN", kind="space", global_id="GREEN", storey_global_id="L1"),
            GraphNode(id="space:BLUE", kind="space", global_id="BLUE", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[
            GraphEdge(
                id="eR",
                kind="space_door",
                source="space:RED",
                target="door:D",
                method="ifc_rel_space_boundary",
                inferred=False,
            ),
        ],
    )
    footprints = FootprintsDocument(
        model_id="m_orient_ifc1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("RED", "L1", -4, -1, 0, 1),
            _box_space("GREEN", "L1", 0.05, -1, 2, 1),
            _box_space("BLUE", "L1", 0.5, -1, 3, 1),
        ],
        doors=[_oriented_door("D", "L1", 0, 0, nx=1, ny=0)],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    geom = [
        e.source if e.source.startswith("space:") else e.target
        for e in geo.edges
        if e.method == "geom_door_space"
    ]
    assert geom == ["space:GREEN"]
    all_links = {
        e.source if e.source.startswith("space:") else e.target
        for e in geo.edges
        if e.kind == "space_door"
    }
    assert all_links == {"space:RED", "space:GREEN"}


def test_door_heal_rejects_same_side_of_ifc_host():
    """
    IFC→RED; door on RED's outer left wall; GREEN below (not through that wall)
    must not be topped up — between-math with RED fails.
    """
    ifc = ConnectivityGraph(
        model_id="m_door_outer",
        variant="ifc",
        nodes=[
            GraphNode(id="space:RED", kind="space", global_id="RED", storey_global_id="L1"),
            GraphNode(id="space:GREEN", kind="space", global_id="GREEN", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[
            GraphEdge(
                id="eR",
                kind="space_door",
                source="space:RED",
                target="door:D",
                method="ifc_rel_space_boundary",
                inferred=False,
            ),
        ],
    )
    footprints = FootprintsDocument(
        model_id="m_door_outer",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("RED", "L1", 0, 0, 4, 4),
            _box_space("GREEN", "L1", 0, -4, 4, -0.2),
        ],
        doors=[
            DoorPortal(
                global_id="D",
                name="D",
                storey_global_id="L1",
                point=Point2D(x=0.05, y=2),  # on/near RED's left face
                segment=[],
                incomplete=False,
                method="ifc_object_placement",
            )
        ],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    assert not any(e.method == "geom_door_space" for e in geo.edges)


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


def test_nested_child_sharing_parent_walls_is_still_detected():
    """
    Child flush in the parent's corner shares two walls, so three of its four
    corners sit exactly on the parent outline where the ray cast is ambiguous.
    It must still count as nested.
    """
    ifc = ConnectivityGraph(
        model_id="m1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:PARENT", kind="space", global_id="PARENT", storey_global_id="L1"),
            GraphNode(id="space:FLUSH", kind="space", global_id="FLUSH", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("PARENT", "L1", 0, 0, 20, 10),
            _box_space("FLUSH", "L1", 0, 0, 5, 5),
        ],
        doors=[],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    by_id = {n.id: n for n in geo.nodes}
    assert by_id["space:PARENT"].nested_parent is True
    assert by_id["space:FLUSH"].nested_parent is False


def test_rooms_sharing_one_wall_are_not_nested_parents():
    """Flush neighbours (no gap) must not flag each other once vertices inset."""
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
            _box_space("B", "L1", 4, 0, 9, 4),
        ],
        doors=[],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    assert all(not n.nested_parent for n in geo.nodes)


def test_space_in_parent_hole_is_not_nested_child():
    """Donut corridor: lift in the courtyard hole must not flag the corridor."""
    ifc = ConnectivityGraph(
        model_id="m1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:002", kind="space", global_id="002", storey_global_id="L1"),
            GraphNode(id="space:LIFT", kind="space", global_id="LIFT", storey_global_id="L1"),
            GraphNode(id="space:INNER", kind="space", global_id="INNER", storey_global_id="L1"),
        ],
        edges=[],
    )
    corridor = _box_space("002", "L1", 0, 0, 20, 10)
    corridor.holes = [
        [
            Point2D(x=6, y=2),
            Point2D(x=14, y=2),
            Point2D(x=14, y=8),
            Point2D(x=6, y=8),
        ]
    ]
    footprints = FootprintsDocument(
        model_id="m1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            corridor,
            # Lift entirely in the hole — not in walkable corridor.
            _box_space("LIFT", "L1", 7, 3, 10, 7),
            # Truly nested room in the walkable ring (left wing).
            _box_space("INNER", "L1", 1, 1, 4, 4),
        ],
        doors=[],
        stairs=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    by_id = {n.id: n for n in geo.nodes}
    # INNER is properly inside the ring → still a nested parent.
    assert by_id["space:002"].nested_parent is True
    assert by_id["space:LIFT"].nested_parent is False
    assert by_id["space:INNER"].nested_parent is False

    # Hole-only child alone must not flag the donut.
    footprints_hole_only = FootprintsDocument(
        model_id="m1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[corridor, _box_space("LIFT", "L1", 7, 3, 10, 7)],
        doors=[],
        stairs=[],
    )
    ifc_hole_only = ConnectivityGraph(
        model_id="m1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:002", kind="space", global_id="002", storey_global_id="L1"),
            GraphNode(id="space:LIFT", kind="space", global_id="LIFT", storey_global_id="L1"),
        ],
        edges=[],
    )
    geo2 = build_geometry_graph(ifc_hole_only, footprints_hole_only)
    assert all(not n.nested_parent for n in geo2.nodes)


def test_opening_heals_open_plan_space_space():
    """No wall in the strip between facing rooms → inferred space_space."""
    ifc = ConnectivityGraph(
        model_id="m1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="space:C", kind="space", global_id="C", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", 0, 0, 4, 4),
            _box_space("B", "L1", 4.2, 0, 8.2, 4),
            _box_space("C", "L1", 20, 0, 24, 4),
        ],
        doors=[],
        openings=[],
        stairs=[],
        walls=[],  # strip empty → open plan
    )
    geo = build_geometry_graph(ifc, footprints)
    opening_edges = [e for e in geo.edges if e.method == "geom_opening_space"]
    assert len(opening_edges) == 1
    assert {opening_edges[0].source, opening_edges[0].target} == {"space:A", "space:B"}
    assert opening_edges[0].portal is not None
    # Clear-span centre sits in the strip between A and B (x≈4.1, mid y).
    assert abs(opening_edges[0].portal.x - 4.1) < 0.25
    assert 0.5 < opening_edges[0].portal.y < 3.5


def test_full_wall_blocks_space_space():
    """Solid wall sealing the strip → no space_space."""
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
            _box_space("B", "L1", 4.2, 0, 8.2, 4),
        ],
        doors=[],
        openings=[],
        stairs=[],
        walls=[_box_wall("W1", "L1", 4.0, 0.0, 4.2, 4.0)],
    )
    geo = build_geometry_graph(ifc, footprints)
    assert not any(e.method == "geom_opening_space" for e in geo.edges)


def test_other_storey_door_does_not_carve_sealed_wall():
    """Stacked door XY from another floor must not punch a sealed same-storey wall."""
    ifc = ConnectivityGraph(
        model_id="m1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L2"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L2"),
            GraphNode(id="space:Z", kind="space", global_id="Z", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m1",
        storeys=[
            {"global_id": "L1", "name": "L1", "elevation": 0.0},
            {"global_id": "L2", "name": "L2", "elevation": 3.0},
        ],
        spaces=[
            _box_space("A", "L2", 0, 0, 4, 4),
            _box_space("B", "L2", 4.2, 0, 8.2, 4),
            _box_space("Z", "L1", 0, 0, 4, 4),
        ],
        doors=[
            DoorPortal(
                global_id="D_L1",
                name="lower door",
                storey_global_id="L1",
                point=Point2D(x=4.1, y=2.0),
                incomplete=False,
                method="ifc_object_placement",
            )
        ],
        openings=[
            OpeningPortal(
                global_id="O_L1",
                name="lower opening",
                storey_global_id="L1",
                point=Point2D(x=4.1, y=2.0),
                incomplete=False,
                method="ifc_object_placement",
                filled_by_door_global_id="D_L1",
            )
        ],
        stairs=[],
        walls=[_box_wall("W1", "L2", 4.0, 0.0, 4.2, 4.0)],
    )
    geo = build_geometry_graph(ifc, footprints)
    assert not any(e.method == "geom_opening_space" for e in geo.edges)


def test_partial_wall_with_opening_allows_space_space():
    """Wall leaves a gap; opening carves clear → space_space."""
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
            _box_space("B", "L1", 4.2, 0, 8.2, 4),
        ],
        doors=[],
        openings=[
            OpeningPortal(
                global_id="O1",
                name="pass",
                storey_global_id="L1",
                point=Point2D(x=4.1, y=2.0),
                incomplete=False,
                method="ifc_object_placement",
                host_global_id="W1",
                host_is_wall=True,
            )
        ],
        stairs=[],
        # Wall only covers bottom half of the frontage; top stays open — and
        # opening at y=2 carves even if hull overlaps.
        walls=[_box_wall("W1", "L1", 4.0, 0.0, 4.2, 1.2)],
    )
    geo = build_geometry_graph(ifc, footprints)
    opening_edges = [e for e in geo.edges if e.method == "geom_opening_space"]
    assert len(opening_edges) == 1
    assert {opening_edges[0].source, opening_edges[0].target} == {"space:A", "space:B"}
    assert opening_edges[0].global_id == "O1"
    assert opening_edges[0].portal is not None
    # Portal is clear-span centre (wide/partial open), not the opening XY alone.
    assert abs(opening_edges[0].portal.x - 4.1) < 0.25
    assert 1.5 < opening_edges[0].portal.y < 3.5


def _sealed_pair_footprints(opening: OpeningPortal) -> FootprintsDocument:
    """Two rooms with a wall sealing the whole frontage, plus one opening."""
    return FootprintsDocument(
        model_id="m1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", 0, 0, 4, 4),
            _box_space("B", "L1", 4.2, 0, 8.2, 4),
        ],
        doors=[],
        openings=[opening],
        stairs=[],
        walls=[_box_wall("W1", "L1", 4.0, 0.0, 4.2, 4.0)],
    )


_SEALED_PAIR_IFC = ConnectivityGraph(
    model_id="m1",
    variant="ifc",
    nodes=[
        GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
        GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
    ],
    edges=[],
)


def test_furniture_opening_does_not_carve_sealed_wall():
    """Revit exports cabinet recesses as openings; they must not punch a wall."""
    footprints = _sealed_pair_footprints(
        OpeningPortal(
            global_id="O_CAB",
            name="M_Tall Cabinet-Single Door(2):800 mm",
            storey_global_id="L1",
            point=Point2D(x=4.1, y=2.0),
            incomplete=False,
            method="ifc_mesh_xy_centroid",
            host_global_id="F1",
            host_is_wall=False,
        )
    )
    geo = build_geometry_graph(_SEALED_PAIR_IFC, footprints)
    assert not any(e.method == "geom_opening_space" for e in geo.edges)


def test_wall_opening_still_carves_sealed_wall():
    """A doorway voiding the wall stays walkable (hulls fill the real hole)."""
    footprints = _sealed_pair_footprints(
        OpeningPortal(
            global_id="O_DOORWAY",
            name="doorway",
            storey_global_id="L1",
            point=Point2D(x=4.1, y=2.0),
            incomplete=False,
            method="ifc_mesh_xy_centroid",
            host_global_id="W1",
            host_is_wall=True,
        )
    )
    geo = build_geometry_graph(_SEALED_PAIR_IFC, footprints)
    opening_edges = [e for e in geo.edges if e.method == "geom_opening_space"]
    assert len(opening_edges) == 1
    assert {opening_edges[0].source, opening_edges[0].target} == {"space:A", "space:B"}


def _void_box(x0: float, y0: float, x1: float, y1: float) -> list[Point2D]:
    return [
        Point2D(x=x0, y=y0),
        Point2D(x=x1, y=y0),
        Point2D(x=x1, y=y1),
        Point2D(x=x0, y=y1),
    ]


def test_wall_profile_void_does_not_carve_sealed_wall():
    """
    Revit exports a wall's own profile void as an IfcOpeningElement hosted by
    that wall. It is large in both plan directions, so it is not a doorway.
    """
    footprints = _sealed_pair_footprints(
        OpeningPortal(
            global_id="O_PROFILE",
            name="Basic Wall:VS-11:2294996",
            storey_global_id="L1",
            point=Point2D(x=4.1, y=2.0),
            incomplete=False,
            method="ifc_mesh_xy_centroid",
            host_global_id="W1",
            host_is_wall=True,
            polygon=_void_box(3.0, 0.0, 5.2, 4.0),
            sill_z=0.0,
            head_z=2.9,
        )
    )
    geo = build_geometry_graph(_SEALED_PAIR_IFC, footprints)
    assert not any(e.method == "geom_opening_space" for e in geo.edges)


def test_measured_doorway_void_carves_sealed_wall():
    """A void thin across the wall and tall enough to walk through still heals."""
    footprints = _sealed_pair_footprints(
        OpeningPortal(
            global_id="O_DOOR",
            name="doorway",
            storey_global_id="L1",
            point=Point2D(x=4.1, y=2.0),
            incomplete=False,
            method="ifc_mesh_xy_centroid",
            host_global_id="W1",
            host_is_wall=True,
            polygon=_void_box(3.98, 1.55, 4.22, 2.45),
            sill_z=0.0,
            head_z=2.1,
        )
    )
    geo = build_geometry_graph(_SEALED_PAIR_IFC, footprints)
    opening_edges = [e for e in geo.edges if e.method == "geom_opening_space"]
    assert len(opening_edges) == 1
    assert {opening_edges[0].source, opening_edges[0].target} == {"space:A", "space:B"}


def test_low_void_does_not_carve_sealed_wall():
    """A duct penetration is door-shaped in plan but far too short to walk."""
    footprints = _sealed_pair_footprints(
        OpeningPortal(
            global_id="O_DUCT",
            name="duct penetration",
            storey_global_id="L1",
            point=Point2D(x=4.1, y=2.0),
            incomplete=False,
            method="ifc_mesh_xy_centroid",
            host_global_id="W1",
            host_is_wall=True,
            polygon=_void_box(3.98, 1.55, 4.22, 2.45),
            sill_z=2.4,
            head_z=2.7,
        )
    )
    geo = build_geometry_graph(_SEALED_PAIR_IFC, footprints)
    assert not any(e.method == "geom_opening_space" for e in geo.edges)


def test_void_carves_its_own_width_not_a_fixed_radius():
    """
    A slot too narrow to walk through must not open the wall. The fixed carve
    radius used to clear ~1.1m of frontage regardless of the void's real size.
    """
    footprints = _sealed_pair_footprints(
        OpeningPortal(
            global_id="O_SLOT",
            name="narrow slot",
            storey_global_id="L1",
            point=Point2D(x=4.1, y=2.0),
            incomplete=False,
            method="ifc_mesh_xy_centroid",
            host_global_id="W1",
            host_is_wall=True,
            polygon=_void_box(3.98, 1.875, 4.22, 2.125),
            sill_z=0.0,
            head_z=2.1,
        )
    )
    geo = build_geometry_graph(_SEALED_PAIR_IFC, footprints)
    assert not any(e.method == "geom_opening_space" for e in geo.edges)


def test_opening_heal_skips_door_filled_pair_already_door_linked():
    """Door already bridges both spaces → no duplicate space_space."""
    ifc = ConnectivityGraph(
        model_id="m1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
            GraphNode(id="door:D", kind="door", global_id="D", storey_global_id="L1"),
        ],
        edges=[
            GraphEdge(
                id="e1",
                kind="space_door",
                source="space:A",
                target="door:D",
                method="ifc_rel_space_boundary",
                inferred=False,
            ),
            GraphEdge(
                id="e2",
                kind="space_door",
                source="space:B",
                target="door:D",
                method="ifc_rel_space_boundary",
                inferred=False,
            ),
        ],
    )
    footprints = FootprintsDocument(
        model_id="m1",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[
            _box_space("A", "L1", 0, 0, 4, 4),
            _box_space("B", "L1", 4.2, 0, 8.2, 4),
        ],
        doors=[
            DoorPortal(
                global_id="D",
                storey_global_id="L1",
                point=Point2D(x=4.1, y=2),
                incomplete=False,
                method="ifc_object_placement",
            )
        ],
        openings=[],
        stairs=[],
        walls=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    assert not any(e.method == "geom_opening_space" for e in geo.edges)


def test_wall_touch_without_clear_span_does_not_heal():
    """Sealed wall, no void carve → no space_space."""
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
            _box_space("B", "L1", 4.2, 0, 8.2, 4),
        ],
        doors=[],
        openings=[],
        stairs=[],
        walls=[_box_wall("W1", "L1", 3.95, -0.1, 4.25, 4.1)],
    )
    geo = build_geometry_graph(ifc, footprints)
    assert not any(e.kind == "space_space" for e in geo.edges)


def test_opening_heal_does_not_cross_storeys():
    """Open-plan strip on L1 only — never L1↔L2."""
    ifc = ConnectivityGraph(
        model_id="m1",
        variant="ifc",
        nodes=[
            GraphNode(id="space:L1A", kind="space", global_id="L1A", storey_global_id="L1"),
            GraphNode(id="space:L1B", kind="space", global_id="L1B", storey_global_id="L1"),
            GraphNode(id="space:L2A", kind="space", global_id="L2A", storey_global_id="L2"),
            GraphNode(id="space:L2B", kind="space", global_id="L2B", storey_global_id="L2"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m1",
        storeys=[
            {"global_id": "L1", "name": "L1", "elevation": 0.0},
            {"global_id": "L2", "name": "L2", "elevation": 3.0},
        ],
        spaces=[
            _box_space("L1A", "L1", 0, 0, 4, 4),
            _box_space("L1B", "L1", 4.2, 0, 8.2, 4),
            _box_space("L2A", "L2", 0, 0, 4, 4),
            _box_space("L2B", "L2", 4.2, 0, 8.2, 4),
        ],
        doors=[],
        openings=[],
        stairs=[],
        walls=[],
    )
    geo = build_geometry_graph(ifc, footprints)
    opening_edges = [e for e in geo.edges if e.method == "geom_opening_space"]
    assert len(opening_edges) == 2  # one per storey open pair
    for e in opening_edges:
        ends = {e.source, e.target}
        assert ends in (
            {"space:L1A", "space:L1B"},
            {"space:L2A", "space:L2B"},
        )


def _stair_spaces(geo: ConnectivityGraph) -> set[str]:
    out: set[str] = set()
    for e in geo.edges:
        if e.method != "geom_stair_space":
            continue
        out.add(e.source if e.source.startswith("space:") else e.target)
    return out


def test_excluding_nested_parent_reassigns_stair_to_lobby():
    """Huge parent wins ∩ area; removing it lets the inner lobby take the stair."""
    hull = [
        Point2D(x=0.5, y=0.5),
        Point2D(x=2.5, y=0.5),
        Point2D(x=2.5, y=2.5),
        Point2D(x=0.5, y=2.5),
    ]
    ifc = ConnectivityGraph(
        model_id="m_ex",
        variant="ifc",
        nodes=[
            GraphNode(id="space:PARENT", kind="space", global_id="PARENT", storey_global_id="L1"),
            GraphNode(id="space:LOBBY", kind="space", global_id="LOBBY", storey_global_id="L1"),
            GraphNode(id="space:L2", kind="space", global_id="L2", storey_global_id="L2"),
            GraphNode(id="stair:S", kind="stair", global_id="S", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m_ex",
        storeys=[
            {"global_id": "L1", "name": "L1", "elevation": 0.0},
            {"global_id": "L2", "name": "L2", "elevation": 3.0},
        ],
        spaces=[
            _box_space("PARENT", "L1", 0, 0, 40, 40),
            # Lobby inset so ∩ with the hull is smaller than the parent's full cover.
            _box_space("LOBBY", "L1", 0, 0, 2.4, 2.4),
            _box_space("L2", "L2", 0, 0, 3, 3),
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
    assert "space:PARENT" in _stair_spaces(geo)
    assert "space:LOBBY" not in _stair_spaces(geo)
    assert "space:L2" in _stair_spaces(geo)

    rehealed = reheal_geometry_graph(
        ifc,
        footprints,
        excluded_node_ids=["space:PARENT"],
        previous=geo,
    )
    spaces = _stair_spaces(rehealed)
    assert "space:PARENT" not in spaces
    assert "space:LOBBY" in spaces
    assert "space:L2" in spaces  # other storey kept / still healed


def test_reheal_empty_exclusions_returns_previous():
    ifc = ConnectivityGraph(model_id="m", variant="ifc", nodes=[], edges=[])
    footprints = FootprintsDocument(model_id="m", storeys=[], spaces=[], doors=[], stairs=[])
    previous = ConnectivityGraph(model_id="m", variant="geometry", nodes=[], edges=[])
    out = reheal_geometry_graph(ifc, footprints, excluded_node_ids=[], previous=previous)
    assert out is previous


def test_corner_opening_clear_span_follows_outline_order():
    """
    L-shaped neighbour wraps south + west of a small room. South is sealed;
    west is a 2 m opening. Measuring along the outline (not centroids) keeps
    that opening ≥ 0.7 m so space↔space heals.
    """
    a = _box_space("A", "L1", 2, 2, 5, 5)
    b = SpaceFootprint(
        global_id="B",
        name="B",
        storey_global_id="L1",
        polygon=[
            Point2D(x=1.85, y=1.85),
            Point2D(x=8.0, y=1.85),
            Point2D(x=8.0, y=1.70),
            Point2D(x=1.70, y=1.70),
            Point2D(x=1.70, y=8.0),
            Point2D(x=1.85, y=8.0),
        ],
        incomplete=False,
        method="ifc_placement_bbox",
    )
    south_wall = _box_wall("WS", "L1", 1.80, 1.80, 5.2, 2.05)
    samples, perimeter = _frontage_strip_samples(a, b)
    blocked = [_point_hits_wall(mid, [south_wall]) for _s, mid in samples]
    span = _max_clear_span_m(samples, blocked, perimeter)
    assert span >= MIN_CLEAR_SPAN_M

    ifc = ConnectivityGraph(
        model_id="m_corner",
        variant="ifc",
        nodes=[
            GraphNode(id="space:A", kind="space", global_id="A", storey_global_id="L1"),
            GraphNode(id="space:B", kind="space", global_id="B", storey_global_id="L1"),
        ],
        edges=[],
    )
    footprints = FootprintsDocument(
        model_id="m_corner",
        storeys=[{"global_id": "L1", "name": "L1", "elevation": 0.0}],
        spaces=[a, b],
        doors=[],
        openings=[],
        stairs=[],
        walls=[south_wall],
    )
    geo = build_geometry_graph(ifc, footprints)
    opening_edges = [e for e in geo.edges if e.method == "geom_opening_space"]
    assert len(opening_edges) == 1
    assert {opening_edges[0].source, opening_edges[0].target} == {"space:A", "space:B"}

