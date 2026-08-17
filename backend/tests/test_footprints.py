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
    assert len(doc["spaces"]) >= 1
    assert all(s["incomplete"] for s in doc["spaces"])
    assert all(len(s["polygon"]) == 0 for s in doc["spaces"])
    assert len(doc["doors"]) >= 1
    assert all(d["incomplete"] for d in doc["doors"])

    fetched = client.get(f"/models/{model_id}/footprints")
    assert fetched.status_code == 200
    assert fetched.json()["model_id"] == model_id

    stored = (get_settings().data_path / "models" / model_id / "model.ifc").read_bytes()
    assert hashlib.sha256(stored).hexdigest() == hashlib.sha256(payload).hexdigest()


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
