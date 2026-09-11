import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    application = create_app()
    with TestClient(application) as test_client:
        yield test_client
    get_settings.cache_clear()


def test_create_and_fetch_route_share(client: TestClient):
    glb_bytes = b"glTF" + b"\x00" * 16  # not a real GLB, just distinguishable bytes

    created = client.post(
        "/route-shares",
        content=glb_bytes,
        headers={"content-type": "model/gltf-binary"},
    )
    assert created.status_code == 201
    body = created.json()
    share_id = body["share_id"]
    assert len(share_id) == 32
    # lan_ip is best-effort (None on a machine with no network route) — the
    # response must carry the key either way, since the frontend reads it.
    assert "lan_ip" in body

    fetched = client.get(f"/route-shares/{share_id}.glb")
    assert fetched.status_code == 200
    assert fetched.content == glb_bytes
    assert fetched.headers["content-type"] == "model/gltf-binary"


def test_reject_empty_upload(client: TestClient):
    response = client.post("/route-shares", content=b"")
    assert response.status_code == 400


def test_unknown_share_id_404s(client: TestClient):
    response = client.get("/route-shares/" + "0" * 32 + ".glb")
    assert response.status_code == 404


def test_path_traversal_share_id_404s(client: TestClient):
    response = client.get("/route-shares/..%2f..%2f..%2fetc%2fpasswd.glb")
    assert response.status_code == 404
