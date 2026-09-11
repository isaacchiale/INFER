import hashlib
import io
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app

FIXTURE = Path(__file__).parent / "fixtures" / "minimal.ifc"
INDOORGML_FIXTURE = Path(__file__).parent / "fixtures" / "sample.indoorgml"


def _zip_bytes(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    application = create_app()
    with TestClient(application) as test_client:
        yield test_client
    get_settings.cache_clear()


def test_reject_non_ifc(client: TestClient):
    response = client.post(
        "/models",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 400


def test_upload_extract_and_immutable_source(client: TestClient):
    payload = FIXTURE.read_bytes()
    original_hash = hashlib.sha256(payload).hexdigest()

    upload = client.post(
        "/models",
        files={"file": ("minimal.ifc", payload, "application/octet-stream")},
    )
    assert upload.status_code == 201
    meta = upload.json()
    model_id = meta["model_id"]
    assert meta["original_filename"] == "minimal.ifc"
    assert meta["extract_status"] == "none"

    got = client.get(f"/models/{model_id}")
    assert got.status_code == 200
    assert got.json()["model_id"] == model_id

    extract = client.post(f"/models/{model_id}/extract")
    assert extract.status_code == 200
    body = extract.json()
    assert body["schema_version"] == "1.0"
    assert len(body["storeys"]) >= 1
    assert any(s["name"] == "Level 1" for s in body["storeys"])
    assert any(s["name"] == "Room 101" for s in body["spaces"])
    assert any(d["name"] == "Door D1" for d in body["doors"])
    assert any(d["name"] == "Emergency Exit E1" for d in body["doors"])
    assert any(e["name"] == "Emergency Exit E1" for e in body["exit_candidates"])
    assert any(s["name"] == "Stair A" for s in body["stairs"])
    assert any(lift["name"] == "Lift 1" for lift in body["lifts"])
    assert all("global_id" in item and item["global_id"] for item in body["doors"])

    entities = client.get(f"/models/{model_id}/entities")
    assert entities.status_code == 200
    assert entities.json()["model_id"] == model_id

    settings = get_settings()
    stored = (settings.data_path / "models" / model_id / "model.ifc").read_bytes()
    assert hashlib.sha256(stored).hexdigest() == original_hash

    refreshed = client.get(f"/models/{model_id}").json()
    assert refreshed["extract_status"] == "ready"


def test_missing_model(client: TestClient):
    assert client.get("/models/does-not-exist").status_code == 404


def test_ifczip_upload_extracts_inner_ifc(client: TestClient):
    """.ifczip is advertised as a supported upload type in the frontend
    picker — the stored model.ifc must be the real unzipped STEP text
    ifcopenshell can open, not the raw zip bytes under a misleading name."""
    inner_bytes = FIXTURE.read_bytes()
    payload = _zip_bytes({"building/model.ifc": inner_bytes})

    upload = client.post(
        "/models",
        files={"file": ("archive.ifczip", payload, "application/octet-stream")},
    )
    assert upload.status_code == 201
    model_id = upload.json()["model_id"]

    extract = client.post(f"/models/{model_id}/extract")
    assert extract.status_code == 200
    assert any(s["name"] == "Room 101" for s in extract.json()["spaces"])

    settings = get_settings()
    stored = (settings.data_path / "models" / model_id / "model.ifc").read_bytes()
    assert hashlib.sha256(stored).hexdigest() == hashlib.sha256(inner_bytes).hexdigest()


def test_ifczip_upload_rejects_invalid_zip(client: TestClient):
    response = client.post(
        "/models",
        files={"file": ("archive.ifczip", b"not a zip file", "application/octet-stream")},
    )
    assert response.status_code == 400


def test_ifczip_upload_rejects_zip_with_no_ifc_inside(client: TestClient):
    payload = _zip_bytes({"readme.txt": b"no ifc here"})
    response = client.post(
        "/models",
        files={"file": ("archive.ifczip", payload, "application/octet-stream")},
    )
    assert response.status_code == 400


def test_upload_rejects_oversized_file(client: TestClient, monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_MB", "0")
    get_settings.cache_clear()
    try:
        payload = FIXTURE.read_bytes()
        response = client.post(
            "/models",
            files={"file": ("minimal.ifc", payload, "application/octet-stream")},
        )
        assert response.status_code == 400

        # No orphaned model directory left behind after a rejected upload.
        settings = get_settings()
        models_root = settings.data_path / "models"
        assert not models_root.exists() or not any(models_root.iterdir())
    finally:
        get_settings.cache_clear()


def test_indoorgml_upload_extract_footprints_and_graph(client: TestClient):
    """Full ingest flow (upload -> extract -> footprints -> graph) through
    the real HTTP API for an IndoorGML file — the same sequence
    IngestDialog.tsx runs for every upload, IFC or not."""
    payload = INDOORGML_FIXTURE.read_bytes()

    upload = client.post(
        "/models",
        files={"file": ("building.indoorgml", payload, "application/xml")},
    )
    assert upload.status_code == 201
    meta = upload.json()
    model_id = meta["model_id"]
    assert meta["source_format"] == "indoorgml"

    extract = client.post(f"/models/{model_id}/extract")
    assert extract.status_code == 200
    assert {s["name"] for s in extract.json()["spaces"]} == {"Room A", "Room B"}

    footprints = client.post(f"/models/{model_id}/footprints")
    assert footprints.status_code == 200
    fp_body = footprints.json()
    assert len(fp_body["spaces"]) == 2
    assert len(fp_body["doors"]) == 1

    # Same default the ingest flow requests for every upload now (see
    # IngestDialog.tsx) — must not 500 trying to run IFC-only healing.
    graph = client.post(f"/models/{model_id}/graph", params={"variant": "geometry"})
    assert graph.status_code == 200
    graph_body = graph.json()
    assert graph_body["variant"] == "geometry"
    assert len(graph_body["nodes"]) == 3  # 2 spaces + 1 door
    assert len(graph_body["edges"]) == 2
    assert all(e["method"] == "indoorgml_transition" for e in graph_body["edges"])

    # GET after POST finds the same variant slot that was just saved.
    fetched_graph = client.get(f"/models/{model_id}/graph", params={"variant": "geometry"})
    assert fetched_graph.status_code == 200
    assert len(fetched_graph.json()["edges"]) == 2

    # Live reheal (the geometry-variant "what-if exclusion" endpoint the
    # frontend calls) must not crash trying to run IFC-only reheal logic.
    live = client.post(f"/models/{model_id}/graph/live", json={"excluded_node_ids": []})
    assert live.status_code == 200
    assert len(live.json()["edges"]) == 2

    settings = get_settings()
    stored = settings.data_path / "models" / model_id / "model.indoorgml"
    assert stored.is_file()
    assert stored.read_bytes() == payload
