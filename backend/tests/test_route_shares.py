import os
import time

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.services import storage


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


def test_expired_shares_swept_on_next_upload(client: TestClient):
    """The router docstring calls this "ephemeral hosting" — verify old
    shares actually get deleted rather than accumulating forever."""
    old = client.post("/route-shares", content=b"old-share-bytes")
    assert old.status_code == 201
    old_id = old.json()["share_id"]

    settings = get_settings()
    old_path = storage.route_share_path(settings, old_id)
    assert old_path.is_file()
    # Back-date it past the expiry window instead of waiting real time.
    cutoff = time.time() - (storage.ROUTE_SHARE_MAX_AGE_DAYS + 1) * 86400
    os.utime(old_path, (cutoff, cutoff))

    new = client.post("/route-shares", content=b"new-share-bytes")
    assert new.status_code == 201
    new_id = new.json()["share_id"]

    assert not old_path.is_file()
    assert client.get(f"/route-shares/{old_id}.glb").status_code == 404
    assert client.get(f"/route-shares/{new_id}.glb").status_code == 200
