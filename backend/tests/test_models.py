import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app

FIXTURE = Path(__file__).parent / "fixtures" / "minimal.ifc"


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
