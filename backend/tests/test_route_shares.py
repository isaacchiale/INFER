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


def test_usdz_upload_attaches_to_existing_share(client: TestClient):
    glb_bytes = b"glTF" + b"\x00" * 16
    created = client.post(
        "/route-shares", content=glb_bytes, headers={"content-type": "model/gltf-binary"}
    )
    share_id = created.json()["share_id"]

    usdz_bytes = b"PK\x03\x04usdz-stand-in"
    attached = client.post(
        f"/route-shares?share_id={share_id}",
        content=usdz_bytes,
        headers={"content-type": "model/vnd.usdz+zip"},
    )
    assert attached.status_code == 201
    body = attached.json()
    assert body["share_id"] == share_id
    assert body["ext"] == "usdz"

    fetched = client.get(f"/route-shares/{share_id}.usdz")
    assert fetched.status_code == 200
    assert fetched.content == usdz_bytes
    assert fetched.headers["content-type"] == "model/vnd.usdz+zip"

    # Both formats now live under the same id.
    still_glb = client.get(f"/route-shares/{share_id}.glb")
    assert still_glb.status_code == 200
    assert still_glb.content == glb_bytes


def test_invalid_share_id_on_attach_is_rejected(client: TestClient):
    response = client.post(
        "/route-shares?share_id=not-a-real-id",
        content=b"bytes",
        headers={"content-type": "model/vnd.usdz+zip"},
    )
    assert response.status_code == 400


def test_landing_redirects_iphone_to_usdz_and_others_to_glb(client: TestClient):
    created = client.post(
        "/route-shares", content=b"glb-bytes", headers={"content-type": "model/gltf-binary"}
    )
    share_id = created.json()["share_id"]
    client.post(
        f"/route-shares?share_id={share_id}",
        content=b"usdz-bytes",
        headers={"content-type": "model/vnd.usdz+zip"},
    )

    iphone_ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
    to_iphone = client.get(
        f"/route-shares/{share_id}", headers={"user-agent": iphone_ua}, follow_redirects=False
    )
    assert to_iphone.status_code == 307
    assert to_iphone.headers["location"] == f"/api/route-shares/{share_id}.usdz"

    android_ua = "Mozilla/5.0 (Linux; Android 14)"
    to_android = client.get(
        f"/route-shares/{share_id}", headers={"user-agent": android_ua}, follow_redirects=False
    )
    assert to_android.status_code == 307
    assert to_android.headers["location"] == f"/api/route-shares/{share_id}.glb"


def test_landing_falls_back_to_whichever_format_exists(client: TestClient):
    """USDZ-only share (e.g. GLB somehow missing) still resolves for a non-iPhone visitor."""
    created = client.post(
        "/route-shares", content=b"usdz-only", headers={"content-type": "model/vnd.usdz+zip"}
    )
    share_id = created.json()["share_id"]

    android_ua = "Mozilla/5.0 (Linux; Android 14)"
    response = client.get(
        f"/route-shares/{share_id}", headers={"user-agent": android_ua}, follow_redirects=False
    )
    assert response.status_code == 307
    assert response.headers["location"] == f"/api/route-shares/{share_id}.usdz"


def test_landing_unknown_share_id_404s(client: TestClient):
    response = client.get("/route-shares/" + "0" * 32)
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
