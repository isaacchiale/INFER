"""
Ephemeral hosting for exported route GLBs so a QR code / link can open the
3D path on another device (e.g. a phone on the same network) without any
app install. The frontend builds the GLB client-side (route-share-scene.ts
+ GLTFExporter) and POSTs the raw bytes here.
"""

from __future__ import annotations

import re
import socket

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from app.config import get_settings
from app.services import storage

router = APIRouter(prefix="/route-shares", tags=["route-shares"])

# A route + a handful of room slabs should be well under 1MB; this is a
# generous ceiling against an accidental oversized upload, not a real limit.
MAX_BYTES = 20 * 1024 * 1024
_SHARE_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _lan_ip() -> str | None:
    """
    Best-effort LAN-facing IP for this machine. A share link built from
    window.location.origin is useless when that origin is "localhost" —
    scanning it from a phone points the phone at itself, not this computer.
    The frontend swaps in this IP when it detects it was opened via
    localhost/127.0.0.1.

    Opening a UDP socket toward a public address never actually sends
    anything (UDP "connect" just picks a local route/interface) — this
    can't reach the network and doesn't need to; it only asks the OS which
    local IP it would use. Returns None (caller keeps localhost) if there's
    no route at all, e.g. a fully offline machine.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


@router.post("", status_code=201)
async def create_route_share(request: Request) -> dict[str, str | None]:
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(body) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large")
    settings = get_settings()
    share_id = storage.save_route_share(settings, body)
    return {"share_id": share_id, "lan_ip": _lan_ip()}


@router.get("/{share_id}.glb")
def get_route_share(share_id: str) -> FileResponse:
    # share_id feeds a filesystem path below — reject anything that isn't
    # exactly the uuid4().hex shape storage.save_route_share() generates,
    # so a crafted id (e.g. "../../etc/passwd") can never escape the
    # route-shares directory.
    if not _SHARE_ID_RE.match(share_id):
        raise HTTPException(status_code=404, detail="Share not found")
    settings = get_settings()
    path = storage.route_share_path(settings, share_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Share not found")
    return FileResponse(path, media_type="model/gltf-binary")
