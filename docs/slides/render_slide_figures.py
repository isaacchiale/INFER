"""Raster plan excerpts from Trapelo footprints for the user-guide slides."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
MODEL = "4ca9d6c3-7df2-4da4-910d-c197565389b9"
SID = "00Anm4s4r7luYkA9gSCCC_"
FP = ROOT / "data" / "derived" / MODEL / "footprints.json"
OUT = ROOT / "docs" / "slides" / "assets"
PAD = 1.4

SPACE_FILL = (226, 232, 240, 255)
SPACE_LINE = (100, 116, 139, 255)
WALL = (71, 85, 105, 220)
FURN = (243, 230, 196, 230)
FURN_LINE = (180, 150, 100, 255)
DOOR = (245, 158, 11, 255)
BG = (248, 250, 252, 255)


def area(poly: list[dict]) -> float:
    n = len(poly)
    if n < 3:
        return 0.0
    acc = 0.0
    for i in range(n):
        x1, y1 = poly[i]["x"], poly[i]["y"]
        x2, y2 = poly[(i + 1) % n]["x"], poly[(i + 1) % n]["y"]
        acc += x1 * y2 - x2 * y1
    return abs(acc) * 0.5


def rings_of(item: dict) -> list[list[dict]]:
    out = []
    if len(item.get("polygon") or []) >= 3:
        out.append(item["polygon"])
    for part in item.get("parts") or []:
        if len(part) >= 3:
            out.append(part)
    return out


def bounds(polys: list[list[dict]]) -> tuple[float, float, float, float]:
    xs, ys = [], []
    for poly in polys:
        for p in poly:
            xs.append(p["x"])
            ys.append(p["y"])
    return min(xs), min(ys), max(xs), max(ys)


def project(x: float, y: float, minx: float, miny: float, maxx: float, maxy: float, w: int, h: int):
    sx = (w - 1) / max(maxx - minx, 1e-6)
    sy = (h - 1) / max(maxy - miny, 1e-6)
    s = min(sx, sy)
    px = (x - minx) * s
    py = (maxy - y) * s
    ox = (w - (maxx - minx) * s) / 2
    oy = (h - (maxy - miny) * s) / 2
    return ox + px, oy + py


def to_pix(poly: list[dict], box, w: int, h: int) -> list[tuple[int, int]]:
    minx, miny, maxx, maxy = box
    return [tuple(map(int, project(p["x"], p["y"], minx, miny, maxx, maxy, w, h))) for p in poly]


def draw_poly(draw: ImageDraw.ImageDraw, pts: list[tuple[int, int]], fill, outline, width: int = 1) -> None:
    if len(pts) < 3:
        return
    draw.polygon(pts, fill=fill, outline=outline)
    if width > 1:
        draw.line(pts + [pts[0]], fill=outline, width=width)


def font(size: int):
    for name in ("C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"):
        if Path(name).is_file():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def in_box(poly: list[dict], box) -> bool:
    minx, miny, maxx, maxy = box
    xs = [p["x"] for p in poly]
    ys = [p["y"] for p in poly]
    return not (max(xs) < minx or min(xs) > maxx or max(ys) < miny or min(ys) > maxy)


def render(path: Path, title: str, box, w: int, h: int, *, walls: bool, furniture: bool, crop_label: str) -> None:
    fp = json.loads(FP.read_text(encoding="utf-8"))
    spaces = [s for s in fp["spaces"] if s.get("storey_global_id") == SID and len(s.get("polygon") or []) >= 3]
    walls_l = [x for x in fp.get("walls") or [] if x.get("storey_global_id") == SID]
    furn = [x for x in fp.get("furniture") or [] if x.get("storey_global_id") == SID]
    doors = [d for d in fp.get("doors") or [] if d.get("storey_global_id") == SID]

    img = Image.new("RGBA", (w, h), BG)
    draw = ImageDraw.Draw(img, "RGBA")
    minx, miny, maxx, maxy = box
    view = (minx - PAD, miny - PAD, maxx + PAD, maxy + PAD)

    for s in spaces:
        if not in_box(s["polygon"], view):
            continue
        draw_poly(draw, to_pix(s["polygon"], view, w, h), SPACE_FILL, SPACE_LINE, 1)
        for hole in s.get("holes") or []:
            if len(hole) >= 3:
                draw_poly(draw, to_pix(hole, view, w, h), BG, SPACE_LINE, 1)

    if walls:
        for wall in walls_l:
            if len(wall.get("polygon") or []) < 3 or not in_box(wall["polygon"], view):
                continue
            draw_poly(draw, to_pix(wall["polygon"], view, w, h), WALL, (51, 65, 85, 255), 1)

    if furniture:
        for item in furn:
            for ring in rings_of(item):
                if not in_box(ring, view):
                    continue
                draw_poly(draw, to_pix(ring, view, w, h), FURN, FURN_LINE, 1)

    for d in doors:
        pt = d.get("point")
        if not pt:
            continue
        if not (view[0] <= pt["x"] <= view[2] and view[1] <= pt["y"] <= view[3]):
            continue
        x, y = project(pt["x"], pt["y"], *view, w, h)
        r = 4
        draw.ellipse((x - r, y - r, x + r, y + r), fill=DOOR)

    img.convert("RGB").save(path, "PNG")
    print("wrote", path)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    fp = json.loads(FP.read_text(encoding="utf-8"))
    abak = [
        x
        for x in fp.get("furniture") or []
        if x.get("storey_global_id") == SID and "Privacy" in (x.get("name") or "")
    ]
    if not abak:
        raise SystemExit("no Abak on Floor 2")
    all_rings = []
    for item in abak:
        all_rings.extend(rings_of(item))
    minx, miny, maxx, maxy = bounds(all_rings)

    # Whole-floor overview (pad from all floor-2 spaces)
    space_rings = [
        s["polygon"]
        for s in fp["spaces"]
        if s.get("storey_global_id") == SID and len(s.get("polygon") or []) >= 3
    ]
    sminx, sminy, smaxx, smaxy = bounds(space_rings)

    render(
        OUT / "plan-floor2-overview.png",
        "Floorplan · one storey (rooms, walls, furniture)",
        (sminx, sminy, smaxx, smaxy),
        1600,
        1000,
        walls=True,
        furniture=True,
        crop_label="Trapelo existing-conditions IFC · Floor 2 footprints (same data the 2D Viewer draws)",
    )

    # Cubicle cluster close-up — true occupancy, empty chair wells
    cx = (minx + maxx) / 2
    cy = (miny + maxy) / 2
    span = 18
    render(
        OUT / "plan-cubicles-closeup.png",
        "Furniture as true shapes (not filled boxes)",
        (cx - span, cy - span * 0.65, cx + span, cy + span * 0.65),
        1400,
        900,
        walls=True,
        furniture=True,
        crop_label="Abak workstations: desk + privacy screens; chair wells stay empty",
    )

    render(
        OUT / "plan-spaces-only.png",
        "Navmesh idea: walkable rooms (furniture hidden)",
        (cx - span, cy - span * 0.65, cx + span, cy + span * 0.65),
        1400,
        900,
        walls=False,
        furniture=False,
        crop_label="Right-click inside a room to set start / end. Doors = amber dots.",
    )


if __name__ == "__main__":
    main()
