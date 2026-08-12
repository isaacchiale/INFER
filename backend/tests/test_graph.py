import hashlib
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app

FIXTURE = Path(__file__).parent / "fixtures" / "minimal.ifc"


def test_build_graph_with_fallback_edges(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    client = TestClient(create_app())

    payload = FIXTURE.read_bytes()
    upload = client.post(
        "/models",
        files={"file": ("minimal.ifc", payload, "application/octet-stream")},
    )
    model_id = upload.json()["model_id"]

    graph_resp = client.post(f"/models/{model_id}/graph")
    assert graph_resp.status_code == 200
    graph = graph_resp.json()
    assert graph["schema_version"] == "1.0"
    assert any(n["kind"] == "space" for n in graph["nodes"])
    assert any(n["kind"] == "door" for n in graph["nodes"])
    assert any(e["kind"] == "space_door" for e in graph["edges"])
    assert any(e["method"] == "same_storey_fallback" for e in graph["edges"])

    fetched = client.get(f"/models/{model_id}/graph")
    assert fetched.status_code == 200
    assert fetched.json()["model_id"] == model_id

    # Source IFC unchanged
    stored = (get_settings().data_path / "models" / model_id / "model.ifc").read_bytes()
    assert hashlib.sha256(stored).hexdigest() == hashlib.sha256(payload).hexdigest()
    get_settings.cache_clear()
