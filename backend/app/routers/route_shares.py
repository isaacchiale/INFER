"""
Ephemeral hosting for exported route files so a QR code / link can open the
3D path on another device (e.g. a phone on the same network) without any
app install. The frontend builds the files client-side (route-share-scene.ts
+ GLTFExporter/USDZExporter) and POSTs the raw bytes here — a GLB for
Android/desktop viewers, and (when the export succeeded) a USDZ so iPhone
Safari can drop straight into native AR Quick Look instead of just
downloading a file it can't open.
"""

from __future__ import annotations

import re
import socket

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse

from app.config import get_settings
from app.services import storage

router = APIRouter(prefix="/route-shares", tags=["route-shares"])

# A route + a handful of room slabs should be well under 1MB; this is a
# generous ceiling against an accidental oversized upload, not a real limit.
MAX_BYTES = 20 * 1024 * 1024
_SHARE_ID_RE = re.compile(r"^[0-9a-f]{32}$")

_CONTENT_TYPE_EXT = {
    "model/gltf-binary": "glb",
    "model/vnd.usdz+zip": "usdz",
}
_MEDIA_TYPE_BY_EXT = {ext: content_type for content_type, ext in _CONTENT_TYPE_EXT.items()}

# Good enough to route the common case (a phone's own Safari/Chrome/etc.
# scanning the QR) into AR Quick Look. iPadOS reporting itself as a desktop
# Mac UA is a known gap — the user asked to sort out iPhone users first, and
# iPad falls back to the .glb download same as before, not a regression.
_IOS_UA_RE = re.compile(r"iPhone|iPod", re.IGNORECASE)


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
async def create_route_share(request: Request, share_id: str | None = None) -> dict[str, str | None]:
    """
    `share_id` is omitted for the first upload of a share (a fresh id is
    minted) and passed back in for a second upload of the same route in a
    different format — the frontend uploads the GLB first, then the USDZ
    (when it built one) under that same id, so both live at one share_id
    for the landing route below to pick between.
    """
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(body) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large")
    if share_id is not None and not _SHARE_ID_RE.match(share_id):
        raise HTTPException(status_code=400, detail="Invalid share_id")
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    ext = _CONTENT_TYPE_EXT.get(content_type, "glb")
    settings = get_settings()
    resolved_id = storage.save_route_share(settings, body, ext, share_id)
    return {"share_id": resolved_id, "ext": ext, "lan_ip": _lan_ip()}


def _get_route_share_file(share_id: str, ext: str) -> FileResponse:
    # share_id feeds a filesystem path below — reject anything that isn't
    # exactly the uuid4().hex shape storage.save_route_share() generates,
    # so a crafted id (e.g. "../../etc/passwd") can never escape the
    # route-shares directory.
    if not _SHARE_ID_RE.match(share_id):
        raise HTTPException(status_code=404, detail="Share not found")
    settings = get_settings()
    path = storage.route_share_path(settings, share_id, ext)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Share not found")
    return FileResponse(path, media_type=_MEDIA_TYPE_BY_EXT[ext])


@router.get("/{share_id}.glb")
def get_route_share_glb(share_id: str) -> FileResponse:
    return _get_route_share_file(share_id, "glb")


@router.get("/{share_id}.usdz")
def get_route_share_usdz(share_id: str) -> FileResponse:
    return _get_route_share_file(share_id, "usdz")


@router.get("/{share_id}")
def get_route_share_landing(share_id: str, request: Request) -> RedirectResponse:
    """
    What the QR code / copied link actually points at: picks the format for
    whichever device opened it, instead of making the sharer guess in
    advance. iPhone Safari (or any iOS browser — AR Quick Look is a
    system-level link handler, not Safari-specific) gets redirected to the
    USDZ so it opens native AR Quick Look directly; everyone else gets the
    GLB. Falls back to whichever format actually exists if only one was
    uploaded (e.g. the USDZ export failed client-side).
    """
    if not _SHARE_ID_RE.match(share_id):
        raise HTTPException(status_code=404, detail="Share not found")
    settings = get_settings()
    has_usdz = storage.route_share_path(settings, share_id, "usdz").is_file()
    has_glb = storage.route_share_path(settings, share_id, "glb").is_file()
    if not has_usdz and not has_glb:
        raise HTTPException(status_code=404, detail="Share not found")

    is_ios = bool(_IOS_UA_RE.search(request.headers.get("user-agent", "")))
    if is_ios and has_usdz:
        ext = "usdz"
    elif has_glb:
        ext = "glb"
    else:
        ext = "usdz"
    return RedirectResponse(url=f"/api/route-shares/{share_id}.{ext}", status_code=307)
