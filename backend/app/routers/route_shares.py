"""
Ephemeral hosting for exported route GLBs so a QR code / link can open the
3D path on another device (e.g. a phone on the same network) without any
app install. The frontend builds the GLB client-side (route-share-scene.ts
+ GLTFExporter) and POSTs the raw bytes here.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from app.config import get_settings
from app.services import storage

router = APIRouter(prefix="/route-shares", tags=["route-shares"])

# A route + a handful of room slabs should be well under 1MB; this is a
# generous ceiling against an accidental oversized upload, not a real limit.
MAX_BYTES = 20 * 1024 * 1024
_SHARE_ID_RE = re.compile(r"^[0-9a-f]{32}$")


@router.post("", status_code=201)
async def create_route_share(request: Request) -> dict[str, str]:
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(body) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large")
    settings = get_settings()
    share_id = storage.save_route_share(settings, body)
    return {"share_id": share_id}


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
