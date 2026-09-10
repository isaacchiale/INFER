"""Footprints API tests: incomplete sparse IFC + placement happy path."""

from __future__ import annotations

import hashlib
from pathlib import Path

import ifcopenshell
import ifcopenshell.api
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.services import footprints as footprints_service

FIXTURE = Path(__file__).parent / "fixtures" / "minimal.ifc"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield TestClient(create_app())
    get_settings.cache_clear()


def _upload(client: TestClient, path: Path) -> str:
    payload = path.read_bytes()
    resp = client.post(
        "/models",
        files={"file": (path.name, payload, "application/octet-stream")},
    )
    assert resp.status_code == 201
    return resp.json()["model_id"]


def test_footprints_incomplete_on_sparse_fixture(client):
    model_id = _upload(client, FIXTURE)
    payload = FIXTURE.read_bytes()

    built = client.post(f"/models/{model_id}/footprints")
    assert built.status_code == 200
    doc = built.json()
    assert doc["schema_version"] == "1.0"
    assert doc["coordinate_system"] == "ifc_world_xy_metres"
    assert any(s["global_id"] for s in doc["storeys"])
    assert "stairs" in doc
    assert isinstance(doc["stairs"], list)
    assert len(doc["spaces"]) >= 1
    assert all(s["incomplete"] for s in doc["spaces"])
    assert all(len(s["polygon"]) == 0 for s in doc["spaces"])
    assert len(doc["doors"]) >= 1
    assert all(d["incomplete"] for d in doc["doors"])
    assert "openings" in doc
    assert isinstance(doc["openings"], list)

    fetched = client.get(f"/models/{model_id}/footprints")
    assert fetched.status_code == 200
    assert fetched.json()["model_id"] == model_id

    stored = (get_settings().data_path / "models" / model_id / "model.ifc").read_bytes()
    assert hashlib.sha256(stored).hexdigest() == hashlib.sha256(payload).hexdigest()


def test_footprints_opening_unfilled_and_door_filled(tmp_path):
    """Opening extract: bare opening + door-filled opening via IfcRelFillsElement."""
    ifc_path = tmp_path / "openings.ifc"
    f = ifcopenshell.file(schema="IFC4")
    project = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="T")
    ifcopenshell.api.run("unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"})
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="S")
    building = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="B")
    storey = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcBuildingStorey", name="L1"
    )
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=project, products=[site])
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=site, products=[building])
    ifcopenshell.api.run(
        "aggregate.assign_object", f, relating_object=building, products=[storey]
    )

    bare = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcOpeningElement", name="Void"
    )
    filled_op = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcOpeningElement", name="DoorVoid"
    )
    door = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcDoor", name="D1")
    ifcopenshell.api.run(
        "spatial.assign_container", f, relating_structure=storey, products=[bare, filled_op, door]
    )
    ifcopenshell.api.run(
        "geometry.edit_object_placement",
        f,
        product=bare,
        matrix=[[1, 0, 0, 1], [0, 1, 0, 2], [0, 0, 1, 0], [0, 0, 0, 1]],
        is_si=True,
    )
    ifcopenshell.api.run(
        "geometry.edit_object_placement",
        f,
        product=filled_op,
        matrix=[[1, 0, 0, 3], [0, 1, 0, 2], [0, 0, 1, 0], [0, 0, 0, 1]],
        is_si=True,
    )
    f.create_entity(
        "IfcRelFillsElement",
        GlobalId=ifcopenshell.guid.new(),
        RelatingOpeningElement=filled_op,
        RelatedBuildingElement=door,
    )

    f.write(str(ifc_path))
    doc = footprints_service.build_footprints("test-openings", str(ifc_path))
    assert len(doc.openings) == 2
    by_name = {o.name: o for o in doc.openings}
    assert by_name["Void"].incomplete is False
    assert by_name["Void"].point is not None
    assert by_name["Void"].filled_by_door_global_id is None
    assert by_name["DoorVoid"].filled_by_door_global_id == door.GlobalId


def test_footprints_placement_bbox_happy_path(tmp_path):
    """Space/door with ObjectPlacement → non-incomplete footprints without mesh."""
    ifc_path = tmp_path / "placed.ifc"
    f = ifcopenshell.file(schema="IFC4")
    project = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="T")
    ifcopenshell.api.run("unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"})
    context = ifcopenshell.api.run("context.add_context", f, context_type="Model")
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="S")
    building = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="B")
    storey = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcBuildingStorey", name="L1"
    )
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=project, products=[site])
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=site, products=[building])
    ifcopenshell.api.run(
        "aggregate.assign_object", f, relating_object=building, products=[storey]
    )

    space = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSpace", name="Room")
    door = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcDoor", name="D1")
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=storey, products=[space])
    ifcopenshell.api.run(
        "spatial.assign_container", f, relating_structure=storey, products=[door]
    )

    ifcopenshell.api.run(
        "geometry.edit_object_placement",
        f,
        product=space,
        matrix=[[1, 0, 0, 5], [0, 1, 0, 3], [0, 0, 1, 0], [0, 0, 0, 1]],
        is_si=True,
    )

    ifcopenshell.api.run(
        "geometry.edit_object_placement",
        f,
        product=door,
        matrix=[[1, 0, 0, 7], [0, 1, 0, 3], [0, 0, 1, 0], [0, 0, 0, 1]],
        is_si=True,
    )

    f.write(str(ifc_path))

    doc = footprints_service.build_footprints("test-model", str(ifc_path))
    assert len(doc.spaces) == 1
    space_fp = doc.spaces[0]
    assert space_fp.incomplete is False
    assert space_fp.method == "ifc_placement_bbox"
    assert len(space_fp.polygon) == 4
    # Default 1×1 m bbox centred on placement (5, 3)
    xs = [p.x for p in space_fp.polygon]
    ys = [p.y for p in space_fp.polygon]
    assert min(xs) == pytest.approx(4.5)
    assert max(xs) == pytest.approx(5.5)
    assert min(ys) == pytest.approx(2.5)
    assert max(ys) == pytest.approx(3.5)

    assert len(doc.doors) == 1
    door_fp = doc.doors[0]
    assert door_fp.incomplete is False
    assert door_fp.point is not None
    assert door_fp.point.x == pytest.approx(7.0)
    assert door_fp.point.y == pytest.approx(3.0)


def test_door_operation_type_extracted_when_set(tmp_path):
    """IfcDoor.OperationType passes through untouched; unset/NOTDEFINED stays None."""
    ifc_path = tmp_path / "door_ops.ifc"
    f = ifcopenshell.file(schema="IFC4")
    project = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="T")
    ifcopenshell.api.run("unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"})
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="S")
    building = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="B")
    storey = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcBuildingStorey", name="L1"
    )
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=project, products=[site])
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=site, products=[building])
    ifcopenshell.api.run(
        "aggregate.assign_object", f, relating_object=building, products=[storey]
    )

    swing = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcDoor", name="Swing")
    sliding = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcDoor", name="Sliding")
    unset = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcDoor", name="Unset")
    notdefined = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcDoor", name="NotDefined"
    )
    swing.OperationType = "SINGLE_SWING_LEFT"
    sliding.OperationType = "SLIDING_TO_RIGHT"
    notdefined.OperationType = "NOTDEFINED"
    ifcopenshell.api.run(
        "spatial.assign_container",
        f,
        relating_structure=storey,
        products=[swing, sliding, unset, notdefined],
    )
    for i, door in enumerate([swing, sliding, unset, notdefined]):
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            f,
            product=door,
            matrix=[[1, 0, 0, float(i)], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
            is_si=True,
        )

    f.write(str(ifc_path))
    doc = footprints_service.build_footprints("door-ops-model", str(ifc_path))
    by_name = {d.name: d for d in doc.doors}
    assert by_name["Swing"].operation_type == "SINGLE_SWING_LEFT"
    assert by_name["Sliding"].operation_type == "SLIDING_TO_RIGHT"
    assert by_name["Unset"].operation_type is None
    assert by_name["NotDefined"].operation_type is None


def test_storey_elevation_millimetres_converted_to_metres(tmp_path):
    """IfcBuildingStorey.Elevation in mm must become metres in footprints."""
    ifc_path = tmp_path / "mm_units.ifc"
    f = ifcopenshell.file(schema="IFC4")
    project = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="T")
    ifcopenshell.api.run(
        "unit.assign_unit", f, length={"is_metric": True, "raw": "MILLIMETERS"}
    )
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="S")
    building = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="B")
    storey = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcBuildingStorey", name="L1"
    )
    storey.Elevation = 3000.0
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=project, products=[site])
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=site, products=[building])
    ifcopenshell.api.run(
        "aggregate.assign_object", f, relating_object=building, products=[storey]
    )
    f.write(str(ifc_path))

    doc = footprints_service.build_footprints("mm-model", str(ifc_path))
    assert len(doc.storeys) == 1
    assert doc.storeys[0].elevation == pytest.approx(3.0)


def test_outline_from_extruded_box_uses_horizontal_faces():
    """Closed prism: all-face projection has no boundary edges; floor faces still outline."""
    # Unit box 0..2 x 0..3 x 0..1
    verts = [
        (0.0, 0.0, 0.0),
        (2.0, 0.0, 0.0),
        (2.0, 3.0, 0.0),
        (0.0, 3.0, 0.0),
        (0.0, 0.0, 1.0),
        (2.0, 0.0, 1.0),
        (2.0, 3.0, 1.0),
        (0.0, 3.0, 1.0),
    ]
    faces = [
        # bottom
        (0, 1, 2),
        (0, 2, 3),
        # top
        (4, 6, 5),
        (4, 7, 6),
        # sides
        (0, 1, 5),
        (0, 5, 4),
        (1, 2, 6),
        (1, 6, 5),
        (2, 3, 7),
        (2, 7, 6),
        (3, 0, 4),
        (3, 4, 7),
    ]
    assert footprints_service._boundary_edges_xy(verts, faces) == []
    outlined = footprints_service.outline_from_mesh_xy(verts, faces)
    assert outlined is not None
    exterior, holes = outlined
    assert holes == []
    xs = [p[0] for p in exterior]
    ys = [p[1] for p in exterior]
    assert min(xs) == pytest.approx(0.0)
    assert max(xs) == pytest.approx(2.0)
    assert min(ys) == pytest.approx(0.0)
    assert max(ys) == pytest.approx(3.0)


def test_outline_preserves_l_shape_concavity():
    """Two-box L mesh must keep the indent (not fill like a convex hull)."""
    # Vertical bar (0,0)-(2,0)-(2,6)-(0,6) + horizontal (2,0)-(6,0)-(6,2)-(2,2)
    verts = [
        (0.0, 0.0, 0.0),
        (2.0, 0.0, 0.0),
        (2.0, 2.0, 0.0),
        (0.0, 2.0, 0.0),
        (2.0, 6.0, 0.0),
        (0.0, 6.0, 0.0),
        (6.0, 0.0, 0.0),
        (6.0, 2.0, 0.0),
    ]
    # indices into verts
    faces = [
        (0, 1, 2),
        (0, 2, 3),
        (3, 2, 4),
        (3, 4, 5),
        (1, 6, 7),
        (1, 7, 2),
    ]
    outlined = footprints_service.outline_from_mesh_xy(verts, faces)
    assert outlined is not None
    exterior, holes = outlined
    assert holes == []
    # Inner corner of the L near (2,2) should be on the outline (concave).
    assert any(abs(p[0] - 2.0) < 0.15 and abs(p[1] - 2.0) < 0.15 for p in exterior)
    # Point in the missing corner of the bounding box must be outside.
    assert not footprints_service._point_in_ring(4.0, 4.0, exterior)


def test_outline_extracts_inner_hole():
    """Square with square courtyard: outer + one hole."""
    # Outer 0..6, hole 2..4 — triangulate as a frame (8 triangles).
    verts = [
        (0.0, 0.0, 0.0),
        (6.0, 0.0, 0.0),
        (6.0, 6.0, 0.0),
        (0.0, 6.0, 0.0),
        (2.0, 2.0, 0.0),
        (4.0, 2.0, 0.0),
        (4.0, 4.0, 0.0),
        (2.0, 4.0, 0.0),
    ]
    faces = [
        # bottom strip
        (0, 1, 5),
        (0, 5, 4),
        # right strip
        (1, 2, 6),
        (1, 6, 5),
        # top strip
        (2, 3, 7),
        (2, 7, 6),
        # left strip
        (3, 0, 4),
        (3, 4, 7),
    ]
    outlined = footprints_service.outline_from_mesh_xy(verts, faces)
    assert outlined is not None
    exterior, holes = outlined
    assert len(holes) == 1
    assert footprints_service._point_in_ring(3.0, 3.0, holes[0])
    assert footprints_service._point_in_ring(3.0, 3.0, exterior)
    assert footprints_service._point_in_ring(1.0, 1.0, exterior)
    assert not footprints_service._point_in_ring(1.0, 3.0, holes[0])
    assert footprints_service._point_in_ring(1.0, 3.0, exterior)
