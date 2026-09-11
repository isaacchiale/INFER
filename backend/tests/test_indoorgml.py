"""IndoorGML parser: two rooms + one door-carrying Transition, verified
against a hand-built synthetic fixture (no real-world sample file exists
in this repo to validate against)."""

from __future__ import annotations

from pathlib import Path

from app.services.indoorgml import parse_indoorgml

FIXTURE = Path(__file__).parent / "fixtures" / "sample.indoorgml"


def test_parses_spaces_doors_and_graph():
    entities, footprints, graph = parse_indoorgml("test-model", str(FIXTURE))

    assert len(footprints.spaces) == 2
    by_name = {s.name: s for s in footprints.spaces}
    assert set(by_name) == {"Room A", "Room B"}
    room_a = by_name["Room A"]
    assert room_a.global_id == "CS_A"
    assert room_a.incomplete is False
    assert room_a.method == "indoorgml_geometry"
    assert len(room_a.polygon) == 4  # closing vertex dropped as a duplicate ring point? see below
    xs = [p.x for p in room_a.polygon]
    ys = [p.y for p in room_a.polygon]
    assert min(xs) == 0 and max(xs) == 10
    assert min(ys) == 0 and max(ys) == 10

    # Both rooms on the same (only) storey — flat 2D geometry, no Z spread.
    assert room_a.storey_global_id == by_name["Room B"].storey_global_id
    assert len(footprints.storeys) == 1

    assert len(footprints.doors) == 1
    door = footprints.doors[0]
    assert door.global_id == "CSB_AB"
    assert door.name == "Door A-B"
    assert door.incomplete is False
    assert door.method == "indoorgml_boundary_centroid"
    # Boundary LineString "10 4 10 6" centroid -> (10, 5), the real
    # CellSpaceBoundary geometry, not the midpoint-of-centres fallback.
    assert door.point is not None
    assert door.point.x == 10
    assert door.point.y == 5

    assert entities.spaces and len(entities.spaces) == 2
    assert entities.doors and len(entities.doors) == 1

    space_nodes = [n for n in graph.nodes if n.kind == "space"]
    door_nodes = [n for n in graph.nodes if n.kind == "door"]
    assert {n.global_id for n in space_nodes} == {"CS_A", "CS_B"}
    assert {n.global_id for n in door_nodes} == {"CSB_AB"}

    assert len(graph.edges) == 2
    assert all(e.method == "indoorgml_transition" for e in graph.edges)
    assert all(e.kind == "space_door" for e in graph.edges)
    assert all(e.inferred is False for e in graph.edges)
    endpoints = {(e.source, e.target) for e in graph.edges}
    assert endpoints == {("space:CS_A", "door:CSB_AB"), ("door:CSB_AB", "space:CS_B")}


def test_cellspaces_with_z_spread_split_into_separate_storeys(tmp_path):
    """3D geometry with a real elevation gap between two rooms -> two
    distinct storeys, not one flat level."""
    xml = FIXTURE.read_text(encoding="utf-8").replace(
        """<core:Geometry2D>
              <gml:Polygon gml:id="geom_CS_B" srsDimension="2">
                <gml:exterior>
                  <gml:LinearRing>
                    <gml:posList>10 0 20 0 20 10 10 10 10 0</gml:posList>
                  </gml:LinearRing>
                </gml:exterior>
              </gml:Polygon>
            </core:Geometry2D>""",
        """<core:Geometry3D>
              <gml:Solid>
                <gml:exterior>
                  <gml:CompositeSurface>
                    <gml:surfaceMember>
                      <gml:Polygon gml:id="geom_CS_B_floor" srsDimension="3">
                        <gml:exterior>
                          <gml:LinearRing>
                            <gml:posList>10 0 4 20 0 4 20 10 4 10 10 4 10 0 4</gml:posList>
                          </gml:LinearRing>
                        </gml:exterior>
                      </gml:Polygon>
                    </gml:surfaceMember>
                  </gml:CompositeSurface>
                </gml:exterior>
              </gml:Solid>
            </core:Geometry3D>""",
    )
    path = tmp_path / "two_storeys.indoorgml"
    path.write_text(xml, encoding="utf-8")

    _entities, footprints, _graph = parse_indoorgml("test-model", str(path))
    assert len(footprints.storeys) == 2
    by_name = {s.name: s for s in footprints.spaces}
    assert by_name["Room A"].storey_global_id != by_name["Room B"].storey_global_id
    elevations = sorted(s.elevation for s in footprints.storeys)
    assert elevations == [0.0, 4.0]


def test_boundary_without_geometry_falls_back_to_cell_centroid_midpoint(tmp_path):
    xml = FIXTURE.read_text(encoding="utf-8").replace(
        """<core:cellSpaceBoundaryGeometry>
            <core:Geometry2D>
              <gml:LineString gml:id="geom_CSB_AB" srsDimension="2">
                <gml:posList>10 4 10 6</gml:posList>
              </gml:LineString>
            </core:Geometry2D>
          </core:cellSpaceBoundaryGeometry>""",
        "",
    )
    path = tmp_path / "no_boundary_geometry.indoorgml"
    path.write_text(xml, encoding="utf-8")

    _entities, footprints, _graph = parse_indoorgml("test-model", str(path))
    assert len(footprints.doors) == 1
    door = footprints.doors[0]
    assert door.method == "indoorgml_transition_midpoint"
    # Room A centre (5, 5), Room B centre (15, 5) -> midpoint (10, 5).
    assert door.point is not None
    assert door.point.x == 10
    assert door.point.y == 5
