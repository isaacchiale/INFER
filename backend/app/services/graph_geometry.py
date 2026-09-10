"""Geometry-based door/stair ↔ space healing on top of an IFC boundary graph."""

from __future__ import annotations

import math
from collections.abc import Iterable
from copy import deepcopy
from dataclasses import dataclass, field

from app.schemas.footprints import (
    DoorPortal,
    FootprintsDocument,
    OpeningPortal,
    Point2D,
    SpaceFootprint,
    WallFootprint,
)
from app.schemas.graph import ConnectivityGraph, GraphEdge, GraphNode


# Legacy clearance when a door has no facing normal (old footprints.json).
DOOR_CLEARANCE_M = 1.0
# Inflate the door plan AABB by this much; only intersecting spaces are candidates.
DOOR_INFLATE_M = 0.5
# Max ray length along ±door normal to the first space footprint.
DOOR_RAY_MAX_M = 1.0
# Stair links require real footprint ∩ hull (no soft clearance — that linked whole floors).
STAIR_INTERSECT_EPS = 1e-4
# Nested-parent detection (geometry variant highlight only — no removal yet).
NESTED_CHILD_VERTEX_IN_PARENT = 0.85
NESTED_CHILD_AREA_RATIO_MAX = 0.98
# Step child corners off the parent outline before the in/out test (shared walls).
NESTED_VERTEX_INSET_M = 0.05


def _normalize_excluded_node_ids(raw: Iterable[str] | None) -> set[str]:
    if not raw:
        return set()
    return {str(x) for x in raw if x}


def _point_in_polygon(x: float, y: float, polygon: list[Point2D]) -> bool:
    if len(polygon) < 3:
        return False
    inside = False
    j = len(polygon) - 1
    for i, pi in enumerate(polygon):
        pj = polygon[j]
        if ((pi.y > y) != (pj.y > y)) and (
            x < (pj.x - pi.x) * (y - pi.y) / (pj.y - pi.y + 1e-15) + pi.x
        ):
            inside = not inside
        j = i
    return inside


def _dist_point_to_segment(
    px: float, py: float, ax: float, ay: float, bx: float, by: float
) -> float:
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    ab2 = abx * abx + aby * aby
    if ab2 < 1e-18:
        return math.hypot(apx, apy)
    t = max(0.0, min(1.0, (apx * abx + apy * aby) / ab2))
    return math.hypot(px - (ax + t * abx), py - (ay + t * aby))


def _dist_point_to_polygon(x: float, y: float, polygon: list[Point2D]) -> float:
    if _point_in_polygon(x, y, polygon):
        return 0.0
    best = float("inf")
    n = len(polygon)
    for i in range(n):
        a = polygon[i]
        b = polygon[(i + 1) % n]
        best = min(best, _dist_point_to_segment(x, y, a.x, a.y, b.x, b.y))
    return best


def _polygon_bbox(polygon: list[Point2D]) -> tuple[float, float, float, float] | None:
    if not polygon:
        return None
    xs = [p.x for p in polygon]
    ys = [p.y for p in polygon]
    return min(xs), min(ys), max(xs), max(ys)


def _bboxes_overlap(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
    pad: float,
) -> bool:
    """True if bbox ``a`` padded by ``pad`` on every side overlaps bbox ``b``."""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return ax0 - pad <= bx1 and bx0 - pad <= ax1 and ay0 - pad <= by1 and by0 - pad <= ay1


def _segments_cross(
    a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D
) -> bool:
    """Proper or touching segment intersection (2D)."""

    def orient(p: Point2D, q: Point2D, r: Point2D) -> float:
        return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)

    def on_seg(p: Point2D, q: Point2D, r: Point2D) -> bool:
        return (
            min(p.x, r.x) - STAIR_INTERSECT_EPS <= q.x <= max(p.x, r.x) + STAIR_INTERSECT_EPS
            and min(p.y, r.y) - STAIR_INTERSECT_EPS <= q.y <= max(p.y, r.y) + STAIR_INTERSECT_EPS
        )

    o1 = orient(a1, a2, b1)
    o2 = orient(a1, a2, b2)
    o3 = orient(b1, b2, a1)
    o4 = orient(b1, b2, a2)
    if o1 * o2 < 0 and o3 * o4 < 0:
        return True
    if abs(o1) <= STAIR_INTERSECT_EPS and on_seg(a1, b1, a2):
        return True
    if abs(o2) <= STAIR_INTERSECT_EPS and on_seg(a1, b2, a2):
        return True
    if abs(o3) <= STAIR_INTERSECT_EPS and on_seg(b1, a1, b2):
        return True
    if abs(o4) <= STAIR_INTERSECT_EPS and on_seg(b1, a2, b2):
        return True
    return False


def _polygons_strictly_intersect(a: list[Point2D], b: list[Point2D]) -> bool:
    """True only when polygons overlap in XY (containment or edge crossing) — no buffer."""
    if len(a) < 3 or len(b) < 3:
        return False
    for p in a:
        if _point_in_polygon(p.x, p.y, b):
            return True
    for p in b:
        if _point_in_polygon(p.x, p.y, a):
            return True
    for i in range(len(a)):
        a1, a2 = a[i], a[(i + 1) % len(a)]
        for j in range(len(b)):
            b1, b2 = b[j], b[(j + 1) % len(b)]
            if _segments_cross(a1, a2, b1, b2):
                return True
    return False


def _polygon_area(polygon: list[Point2D]) -> float:
    """Absolute shoelace area (m²)."""
    if len(polygon) < 3:
        return 0.0
    acc = 0.0
    n = len(polygon)
    for i in range(n):
        j = (i + 1) % n
        acc += polygon[i].x * polygon[j].y - polygon[j].x * polygon[i].y
    return abs(acc) * 0.5


def _closest_point_on_segment(
    px: float, py: float, ax: float, ay: float, bx: float, by: float
) -> tuple[Point2D, float]:
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    ab2 = abx * abx + aby * aby
    if ab2 < 1e-18:
        return Point2D(x=ax, y=ay), math.hypot(apx, apy)
    t = max(0.0, min(1.0, (apx * abx + apy * aby) / ab2))
    qx, qy = ax + t * abx, ay + t * aby
    return Point2D(x=qx, y=qy), math.hypot(px - qx, py - qy)


def _closest_point_on_polygon(
    p: Point2D, polygon: list[Point2D]
) -> tuple[Point2D, float]:
    """Closest point of polygon to p; if p is inside, returns p with distance 0."""
    if len(polygon) < 3:
        return p, float("inf")
    if _point_in_polygon(p.x, p.y, polygon):
        return p, 0.0
    best_pt = polygon[0]
    best_d = float("inf")
    n = len(polygon)
    for i in range(n):
        a = polygon[i]
        b = polygon[(i + 1) % n]
        q, d = _closest_point_on_segment(p.x, p.y, a.x, a.y, b.x, b.y)
        if d < best_d:
            best_d = d
            best_pt = q
    return best_pt, best_d


# Cosine threshold when both contacts are outside the door: approach directions
# must be roughly opposite. -0.35 ⇒ angle ≳ ~110° (rejects ~90° corner false pairs).
DOOR_BETWEEN_DOT_MAX = -0.35
# When door is on/in one space: other contact must lie outward through that wall.
DOOR_OUTWARD_DOT_MIN = 0.25
# Outside both: |contact_A − contact_B| must be ≈ da+db (collinear through door).
DOOR_CONTACT_COLLINEAR_SLACK_M = 0.2
# Inside one: other space must meet near the door (same opening), metres.
DOOR_INSIDE_OTHER_MAX_M = 0.45


def _polygon_signed_area(polygon: list[Point2D]) -> float:
    acc = 0.0
    n = len(polygon)
    for i in range(n):
        j = (i + 1) % n
        acc += polygon[i].x * polygon[j].y - polygon[j].x * polygon[i].y
    return acc * 0.5


def _outward_normal_at_closest_edge(
    p: Point2D, polygon: list[Point2D]
) -> tuple[float, float] | None:
    """Unit outward normal of the polygon edge closest to p (CCW ring → outward)."""
    if len(polygon) < 3:
        return None
    best_d = float("inf")
    best_i = 0
    n = len(polygon)
    for i in range(n):
        a = polygon[i]
        b = polygon[(i + 1) % n]
        d = _dist_point_to_segment(p.x, p.y, a.x, a.y, b.x, b.y)
        if d < best_d:
            best_d = d
            best_i = i
    a = polygon[best_i]
    b = polygon[(best_i + 1) % n]
    ex, ey = b.x - a.x, b.y - a.y
    el = math.hypot(ex, ey)
    if el < 1e-12:
        return None
    # Left normal of directed edge; for CCW boundary that points inward.
    nx, ny = -ey / el, ex / el
    if _polygon_signed_area(polygon) < 0:
        # CW ring — flip so "left" of edge is still interior-ish, then outward flips.
        nx, ny = -nx, -ny
    # Outward = opposite of inward.
    return (-nx, -ny)


def _door_between_spaces(
    door: Point2D, a: SpaceFootprint, b: SpaceFootprint
) -> bool:
    """
    True when the door sits between two spaces, using closest footprint points
    (not centroids — more stable for long/large rooms).

    - D inside both → connect
    - D outside both → contacts near the same opening AND approach directions
      roughly opposite (rejects perpendicular “around the corner” pairs)
    - D inside exactly one (host) → other contact must lie roughly along the host's
      outward wall normal at the door (through that face toward the other room)
    """
    if len(a.polygon) < 3 or len(b.polygon) < 3:
        return False
    pa, da = _closest_point_on_polygon(door, a.polygon)
    pb, db = _closest_point_on_polygon(door, b.polygon)
    inside_a = da <= STAIR_INTERSECT_EPS
    inside_b = db <= STAIR_INTERSECT_EPS
    if inside_a and inside_b:
        return True

    if inside_a ^ inside_b:
        host = a if inside_a else b
        other_pt = pb if inside_a else pa
        other_d = db if inside_a else da
        # Other room must meet the door at the same opening, not a far wall.
        if other_d > DOOR_INSIDE_OTHER_MAX_M:
            return False
        outward = _outward_normal_at_closest_edge(door, host.polygon)
        if outward is None:
            return False
        vx, vy = other_pt.x - door.x, other_pt.y - door.y
        L = math.hypot(vx, vy)
        if L < 1e-9:
            return True
        return (vx / L) * outward[0] + (vy / L) * outward[1] > DOOR_OUTWARD_DOT_MIN

    # Outside both: contacts collinear through the door + opposite approach.
    contact_sep = math.hypot(pa.x - pb.x, pa.y - pb.y)
    if contact_sep > da + db + DOOR_CONTACT_COLLINEAR_SLACK_M:
        return False
    ax, ay = pa.x - door.x, pa.y - door.y
    bx, by = pb.x - door.x, pb.y - door.y
    la = math.hypot(ax, ay)
    lb = math.hypot(bx, by)
    if la < 1e-9 or lb < 1e-9:
        return False
    dot = (ax / la) * (bx / lb) + (ay / la) * (by / lb)
    return dot < DOOR_BETWEEN_DOT_MAX


# Space↔space heal: facing frontage + strip clearance (walls − opening/door voids).
INTERFACE_SAMPLE_M = 0.12
# Max gap between footprints to count as a shared interface (wall thickness).
INTERFACE_GAP_MAX_M = 0.45
MIN_INTERFACE_LEN_M = 0.5
# Walkable clear span along the frontage after carving voids.
MIN_CLEAR_SPAN_M = 0.7
# Mid-strip point is "in wall" if inside wall poly or within this distance.
WALL_HIT_TOL_M = 0.08
# Carve this radius around a portal whose plan extent is unknown (doors, and
# openings from footprints built before plan hulls were recorded).
VOID_CARVE_RADIUS_M = 0.55
# Slack around a measured void, for sampling granularity only. Kept to half a
# sample step: the distance test is isotropic, so slack widens the carve along
# the wall too, and a generous value would re-inflate narrow voids.
VOID_CARVE_SLACK_M = 0.06
# A doorway is thin across the wall. A void this thick in its narrow direction
# is a wall-profile void or shaft, not something to punch through a partition.
VOID_MAX_THICKNESS_M = 0.8
# Below this clear height a void is a duct hole, hatch or window band.
VOID_MIN_CLEAR_HEIGHT_M = 1.8
# Split disjoint contact patches when outline-arc gap exceeds this (≈3 sample steps).
FRONTAGE_CHAIN_GAP_M = 0.4


def _sample_polygon_boundary(
    polygon: list[Point2D], step: float = INTERFACE_SAMPLE_M
) -> list[Point2D]:
    if len(polygon) < 3 or step <= 0:
        return []
    pts: list[Point2D] = []
    n = len(polygon)
    for i in range(n):
        a = polygon[i]
        b = polygon[(i + 1) % n]
        seg_len = math.hypot(b.x - a.x, b.y - a.y)
        if seg_len < 1e-9:
            continue
        count = max(1, int(math.ceil(seg_len / step)))
        for k in range(count + 1):
            t = k / count
            pts.append(Point2D(x=a.x + t * (b.x - a.x), y=a.y + t * (b.y - a.y)))
    return pts


def _interface_length_and_gap(
    a: SpaceFootprint, b: SpaceFootprint, gap_max: float = INTERFACE_GAP_MAX_M
) -> tuple[float, float]:
    """Shared-frontage length + mean gap. Length 0 if no interface."""
    if len(a.polygon) < 3 or len(b.polygon) < 3:
        return 0.0, float("inf")
    hits: list[float] = []
    for p in _sample_polygon_boundary(a.polygon):
        d = _dist_point_to_polygon(p.x, p.y, b.polygon)
        if d <= gap_max:
            hits.append(d)
    for p in _sample_polygon_boundary(b.polygon):
        d = _dist_point_to_polygon(p.x, p.y, a.polygon)
        if d <= gap_max:
            hits.append(d)
    if not hits:
        return 0.0, float("inf")
    length = (len(hits) * INTERFACE_SAMPLE_M) / 2.0
    mean_gap = sum(hits) / len(hits)
    return length, mean_gap


def _boundary_samples_arclen(
    polygon: list[Point2D], step: float = INTERFACE_SAMPLE_M
) -> tuple[list[tuple[float, Point2D]], float]:
    """
    Sample the ring in vertex order. Each point carries arc length from
    vertex 0. Closing vertex is omitted (not duplicated as s=0).
    Returns (samples, perimeter).
    """
    n = len(polygon)
    if n < 3 or step <= 0:
        return [], 0.0
    samples: list[tuple[float, Point2D]] = []
    perimeter = 0.0
    for i in range(n):
        a = polygon[i]
        b = polygon[(i + 1) % n]
        seg_len = math.hypot(b.x - a.x, b.y - a.y)
        if seg_len < 1e-9:
            continue
        count = max(1, int(math.ceil(seg_len / step)))
        for k in range(count):
            t = k / count
            samples.append(
                (
                    perimeter + t * seg_len,
                    Point2D(x=a.x + t * (b.x - a.x), y=a.y + t * (b.y - a.y)),
                )
            )
        perimeter += seg_len
    return samples, perimeter


def _frontage_strip_samples(
    a: SpaceFootprint, b: SpaceFootprint, gap_max: float = INTERFACE_GAP_MAX_M
) -> tuple[list[tuple[float, Point2D]], float]:
    """
    Samples along the shared frontage in A's outline order.

    Each item is (arc length along A, midpoint in the strip toward B).
    Disjoint contact patches stay separated by large arc gaps.
    """
    if len(a.polygon) < 3 or len(b.polygon) < 3:
        return [], 0.0
    boundary, perimeter = _boundary_samples_arclen(a.polygon)
    samples: list[tuple[float, Point2D]] = []
    for s, p in boundary:
        d = _dist_point_to_polygon(p.x, p.y, b.polygon)
        if d > gap_max:
            continue
        q, _ = _closest_point_on_polygon(p, b.polygon)
        mid = Point2D(x=0.5 * (p.x + q.x), y=0.5 * (p.y + q.y))
        samples.append((s, mid))
    return samples, perimeter


def _frontage_chains(
    samples: list[tuple[float, Point2D]], perimeter: float
) -> tuple[list[list[int]], bool]:
    """
    Index groups of consecutive outline samples.
    Returns (chains, full_ring) where full_ring means the facing set wraps
    the whole perimeter as one loop.
    """
    if not samples:
        return [], False
    chains: list[list[int]] = [[0]]
    for i in range(1, len(samples)):
        if samples[i][0] - samples[i - 1][0] > FRONTAGE_CHAIN_GAP_M:
            chains.append([i])
        else:
            chains[-1].append(i)
    wrap = (
        perimeter > FRONTAGE_CHAIN_GAP_M
        and (samples[0][0] + perimeter - samples[-1][0]) <= FRONTAGE_CHAIN_GAP_M
    )
    if not wrap:
        return chains, False
    if len(chains) == 1:
        return chains, True
    merged = [chains[-1] + chains[0]] + chains[1:-1]
    return merged, False


def _unwrap_chain_s(
    samples: list[tuple[float, Point2D]],
    indices: list[int],
    perimeter: float,
) -> list[float]:
    out: list[float] = []
    for i, idx in enumerate(indices):
        s = samples[idx][0]
        if i > 0 and s + 1e-9 < out[-1]:
            s += perimeter
        out.append(s)
    return out


def _longest_clear_on_chain(
    s_vals: list[float],
    blocked: list[bool],
    mids: list[Point2D],
    *,
    circular: bool,
    perimeter: float,
) -> tuple[float, list[Point2D]]:
    """Longest clear run on one chain. Span is outline arc length."""
    n = len(s_vals)
    if n == 0:
        return 0.0, []
    if n != len(blocked) or n != len(mids):
        return 0.0, []

    def scan(ss: list[float], bb: list[bool], mm: list[Point2D], limit: int) -> tuple[float, list[Point2D]]:
        best_span = 0.0
        best_mids: list[Point2D] = []
        i = 0
        while i < limit:
            if bb[i]:
                i += 1
                continue
            j = i
            while j < len(bb) and not bb[j] and j < i + n:
                j += 1
            span = ss[j - 1] - ss[i]
            if span < 1e-9:
                span = INTERFACE_SAMPLE_M
            if span > best_span:
                best_span = span
                best_mids = mm[i:j]
            i = j
        return best_span, best_mids

    if circular and n > 1:
        ss = s_vals + [x + perimeter for x in s_vals]
        bb = blocked + blocked
        mm = mids + mids
        return scan(ss, bb, mm, n)
    return scan(s_vals, blocked, mids, n)


def _best_clear_run(
    samples: list[tuple[float, Point2D]],
    blocked: list[bool],
    perimeter: float,
) -> tuple[float, list[Point2D]]:
    if not samples or len(samples) != len(blocked):
        return 0.0, []
    chains, full_ring = _frontage_chains(samples, perimeter)
    best_span = 0.0
    best_mids: list[Point2D] = []
    for chain in chains:
        s_vals = _unwrap_chain_s(samples, chain, perimeter)
        bb = [blocked[i] for i in chain]
        mm = [samples[i][1] for i in chain]
        span, run_mids = _longest_clear_on_chain(
            s_vals, bb, mm, circular=full_ring, perimeter=perimeter
        )
        if span > best_span:
            best_span = span
            best_mids = run_mids
    if best_span < 1e-9 and any(not b for b in blocked):
        best_span = INTERFACE_SAMPLE_M
        best_mids = [mid for (_s, mid), b in zip(samples, blocked) if not b][:1]
    return best_span, best_mids


def _point_hits_wall(
    p: Point2D, walls: list[WallFootprint], tol: float = WALL_HIT_TOL_M
) -> bool:
    for wall in walls:
        if len(wall.polygon) < 3:
            continue
        if _point_in_polygon(p.x, p.y, wall.polygon):
            return True
        if _dist_point_to_polygon(p.x, p.y, wall.polygon) <= tol:
            return True
    return False


# Grid cell for the wall spatial index used by strip healing. Far larger than
# any tolerance this module checks against a wall (WALL_HIT_TOL_M etc.), so a
# point's own cell plus its 8 neighbours always covers every wall that could
# be within tolerance — no false negatives vs. scanning every wall.
_WALL_GRID_CELL_M = 2.0


def _wall_grid_cell(x: float, y: float, cell: float = _WALL_GRID_CELL_M) -> tuple[int, int]:
    return (math.floor(x / cell), math.floor(y / cell))


def _build_wall_grid(
    walls: list[WallFootprint], cell: float = _WALL_GRID_CELL_M
) -> dict[tuple[int, int], list[WallFootprint]]:
    """
    Bucket walls by the grid cells their bbox touches, built once per storey so
    strip healing doesn't rescan every wall on the storey for every sample
    point of every space pair (see ``_walls_near_point``).
    """
    grid: dict[tuple[int, int], list[WallFootprint]] = {}
    for wall in walls:
        bbox = _polygon_bbox(wall.polygon)
        if bbox is None:
            continue
        minx, miny, maxx, maxy = bbox
        gx0, gy0 = _wall_grid_cell(minx, miny, cell)
        gx1, gy1 = _wall_grid_cell(maxx, maxy, cell)
        for gx in range(gx0, gx1 + 1):
            for gy in range(gy0, gy1 + 1):
                grid.setdefault((gx, gy), []).append(wall)
    return grid


def _walls_near_point(
    grid: dict[tuple[int, int], list[WallFootprint]],
    x: float,
    y: float,
    cell: float = _WALL_GRID_CELL_M,
) -> list[WallFootprint]:
    gx, gy = _wall_grid_cell(x, y, cell)
    seen: set[int] = set()
    out: list[WallFootprint] = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for wall in grid.get((gx + dx, gy + dy), ()):
                if id(wall) in seen:
                    continue
                seen.add(id(wall))
                out.append(wall)
    return out


def _max_clear_span_m(
    samples: list[tuple[float, Point2D]],
    blocked: list[bool],
    perimeter: float = 0.0,
) -> float:
    """Longest contiguous clear run along A's outline frontage."""
    span, _mids = _best_clear_run(samples, blocked, perimeter)
    return span


# Prefer centre of the whole clear frontage when most of the strip is open.
CLEAR_FRONTAGE_WIDE_FRAC = 0.7


def _clear_span_portal(
    samples: list[tuple[float, Point2D]],
    blocked: list[bool],
    perimeter: float = 0.0,
) -> Point2D | None:
    """
    Door-like portal on the shared frontage:
    - If ≥ CLEAR_FRONTAGE_WIDE_FRAC of samples are clear → centre of all clear
      midpoints (wide opening / open plan).
    - Else → centre of the longest contiguous clear run (narrow doorway).
    """
    if not samples or len(samples) != len(blocked):
        return None

    clear_mids = [mid for (_t, mid), is_blocked in zip(samples, blocked) if not is_blocked]
    if not clear_mids:
        return None

    clear_frac = len(clear_mids) / len(samples)
    if clear_frac >= CLEAR_FRONTAGE_WIDE_FRAC:
        return Point2D(
            x=sum(p.x for p in clear_mids) / len(clear_mids),
            y=sum(p.y for p in clear_mids) / len(clear_mids),
        )

    _span, run_mids = _best_clear_run(samples, blocked, perimeter)
    if not run_mids:
        return None
    return Point2D(
        x=sum(p.x for p in run_mids) / len(run_mids),
        y=sum(p.y for p in run_mids) / len(run_mids),
    )


@dataclass(frozen=True)
class VoidPortal:
    """A place where a wall strip may be punched clear again."""

    point: Point2D
    # Plan hull of the void. Empty when the extent was never measured, in which
    # case `radius` is the fallback reach.
    polygon: list[Point2D] = field(default_factory=list)
    radius: float = VOID_CARVE_RADIUS_M

    def covers(self, p: Point2D) -> bool:
        if len(self.polygon) >= 3:
            if _point_in_polygon(p.x, p.y, self.polygon):
                return True
            return _dist_point_to_polygon(p.x, p.y, self.polygon) <= VOID_CARVE_SLACK_M
        return math.hypot(p.x - self.point.x, p.y - self.point.y) <= self.radius

    def reach(self) -> float:
        """Max distance from `point` at which this portal can carve."""
        if len(self.polygon) >= 3:
            far = max(
                math.hypot(v.x - self.point.x, v.y - self.point.y)
                for v in self.polygon
            )
            return far + VOID_CARVE_SLACK_M
        return self.radius


def _caliper_widths(polygon: list[Point2D]) -> tuple[float, float]:
    """
    (min, max) width of a convex ring over all edge-normal directions.

    Rotation invariant, unlike an axis-aligned box: a doorway in a diagonal
    wall is still thin across the wall and long along it.
    """
    n = len(polygon)
    if n < 3:
        return 0.0, 0.0
    widths: list[float] = []
    for i in range(n):
        a = polygon[i]
        b = polygon[(i + 1) % n]
        ex, ey = b.x - a.x, b.y - a.y
        elen = math.hypot(ex, ey)
        if elen < 1e-9:
            continue
        nx, ny = -ey / elen, ex / elen
        projections = [p.x * nx + p.y * ny for p in polygon]
        widths.append(max(projections) - min(projections))
    if not widths:
        return 0.0, 0.0
    return min(widths), max(widths)


def _void_is_walkable_shape(opening: OpeningPortal) -> bool:
    """
    Whether a void looks like something a person walks through.

    Revit exports wall-profile voids, shafts, duct penetrations and window
    bands as ``IfcOpeningElement`` alongside real doorways. Both tests are
    purely local to the void: sill height above the floor would be the natural
    third test, but it needs the opening's storey and that elevation to both be
    right, and openings inherit the storey of a wall that may span floors —
    which rejected real ground-floor doors.

    Footprints built before extents were recorded have neither hull nor Z, and
    stay eligible so cached models keep their existing edges.
    """
    if len(opening.polygon) >= 3:
        thickness, _length = _caliper_widths(opening.polygon)
        if thickness > VOID_MAX_THICKNESS_M:
            return False
    if opening.sill_z is not None and opening.head_z is not None:
        if opening.head_z - opening.sill_z < VOID_MIN_CLEAR_HEIGHT_M:
            return False
    return True


def _carve_voids(
    samples: list[tuple[float, Point2D]],
    blocked: list[bool],
    portals: list[VoidPortal],
) -> None:
    for i, (_t, mid) in enumerate(samples):
        for portal in portals:
            if portal.covers(mid):
                blocked[i] = False
                break


def _strip_clear_portal(
    a: SpaceFootprint,
    b: SpaceFootprint,
    wall_grid: dict[tuple[int, int], list[WallFootprint]],
    void_portals: list[VoidPortal],
) -> Point2D | None:
    """
    If the facing strip has a clear span ≥ MIN_CLEAR_SPAN_M after wall hits and
    void carving, return the centre of that clear opening (door-like portal).
    Otherwise None.

    ``wall_grid`` is the storey's walls spatially indexed via
    ``_build_wall_grid`` — built once per storey by the caller, since this
    runs per space pair and a per-call flat scan of every storey wall doesn't
    scale on a real building.
    """
    samples, perimeter = _frontage_strip_samples(a, b)
    if len(samples) < 2:
        return None

    blocked = [
        _point_hits_wall(mid, _walls_near_point(wall_grid, mid.x, mid.y))
        for _t, mid in samples
    ]
    _carve_voids(samples, blocked, void_portals)
    portal = _clear_span_portal(samples, blocked, perimeter)
    if portal is None:
        return None
    if _max_clear_span_m(samples, blocked, perimeter) < MIN_CLEAR_SPAN_M:
        return None
    return portal


def _strip_is_walkable(
    a: SpaceFootprint,
    b: SpaceFootprint,
    walls: list[WallFootprint],
    void_portals: list[VoidPortal],
) -> bool:
    """True when the facing strip has a clear span ≥ MIN_CLEAR_SPAN_M."""
    return _strip_clear_portal(a, b, _build_wall_grid(walls), void_portals) is not None


def _spaces_already_door_linked(
    a_id: str, b_id: str, linked_door_spaces: set[tuple[str, str]]
) -> bool:
    """True if some door already links both spaces (space–door–space covered)."""
    doors_a = {did for (did, sid) in linked_door_spaces if sid == a_id}
    doors_b = {did for (did, sid) in linked_door_spaces if sid == b_id}
    return bool(doors_a & doors_b)


def _opening_on_interface(
    portal: Point2D, a: SpaceFootprint, b: SpaceFootprint
) -> bool:
    """Fallback when wall footprints are missing: portal between facing spaces."""
    da = _dist_point_to_polygon(portal.x, portal.y, a.polygon)
    db = _dist_point_to_polygon(portal.x, portal.y, b.polygon)
    if da > VOID_CARVE_RADIUS_M + 0.3 or db > VOID_CARVE_RADIUS_M + 0.3:
        return False
    return _door_between_spaces(portal, a, b)


def _door_aabb(door: DoorPortal) -> tuple[float, float, float, float] | None:
    """Axis-aligned bounds of the door polygon, segment, or point."""
    pts: list[Point2D] = []
    if door.polygon and len(door.polygon) >= 2:
        pts.extend(door.polygon)
    elif len(door.segment) >= 2:
        pts.extend(door.segment)
    elif door.point is not None:
        # Tiny box so inflate still has something to grow.
        p = door.point
        return (p.x - 0.05, p.y - 0.05, p.x + 0.05, p.y + 0.05)
    else:
        return None
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def _inflate_aabb(
    box: tuple[float, float, float, float], pad: float
) -> tuple[float, float, float, float]:
    minx, miny, maxx, maxy = box
    return (minx - pad, miny - pad, maxx + pad, maxy + pad)


def _aabb_intersects(
    a: tuple[float, float, float, float], b: tuple[float, float, float, float]
) -> bool:
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def _space_aabb(space: SpaceFootprint) -> tuple[float, float, float, float] | None:
    if len(space.polygon) < 3:
        return None
    xs = [p.x for p in space.polygon]
    ys = [p.y for p in space.polygon]
    return (min(xs), min(ys), max(xs), max(ys))


def _spaces_intersecting_inflated_door(
    door: DoorPortal, spaces: list[SpaceFootprint]
) -> list[SpaceFootprint]:
    box = _door_aabb(door)
    if box is None:
        return []
    inflated = _inflate_aabb(box, DOOR_INFLATE_M)
    out: list[SpaceFootprint] = []
    for space in spaces:
        sb = _space_aabb(space)
        if sb is None:
            continue
        if _aabb_intersects(inflated, sb):
            out.append(space)
    return out


def _ray_enter_t(
    ox: float, oy: float, dx: float, dy: float, polygon: list[Point2D]
) -> float | None:
    """
    Smallest t ≥ 0 where the ray (ox,oy)+t·(dx,dy) enters the polygon.
    If the origin is already inside, returns 0.
    """
    if len(polygon) < 3:
        return None
    if _point_in_polygon(ox, oy, polygon):
        return 0.0
    best: float | None = None
    n = len(polygon)
    for i in range(n):
        a = polygon[i]
        b = polygon[(i + 1) % n]
        ex, ey = b.x - a.x, b.y - a.y
        den = dx * ey - dy * ex
        if abs(den) < 1e-12:
            continue
        # Solve ox+t dx = a+u ex, oy+t dy = a+u ey
        t = ((a.x - ox) * ey - (a.y - oy) * ex) / den
        u = ((a.x - ox) * dy - (a.y - oy) * dx) / den
        if t < -1e-9 or u < -1e-9 or u > 1.0 + 1e-9:
            continue
        if best is None or t < best:
            best = max(t, 0.0)
    return best


def _first_space_along_ray(
    ox: float,
    oy: float,
    dx: float,
    dy: float,
    candidates: list[SpaceFootprint],
    *,
    max_t: float = DOOR_RAY_MAX_M,
    skip_gids: set[str] | None = None,
) -> tuple[float, SpaceFootprint] | None:
    skip = skip_gids or set()
    best: tuple[float, SpaceFootprint] | None = None
    for space in candidates:
        if space.global_id in skip:
            continue
        t = _ray_enter_t(ox, oy, dx, dy, space.polygon)
        if t is None or t > max_t + 1e-9:
            continue
        if best is None or t < best[0] or (
            abs(t - best[0]) <= 1e-9 and space.global_id < best[1].global_id
        ):
            best = (t, space)
    return best


def _pick_door_spaces_oriented(
    door: DoorPortal, candidates: list[SpaceFootprint]
) -> list[SpaceFootprint]:
    """
    Inflate-filter + ±normal raycast. At most two spaces (one per side).

    Spaces that contain the door are hosts (always linked). Each ray then
    looks for the first *further* hit (t > 0) so a door sitting inside room A
    near corridor B still picks up B on the outward ray.
    """
    if door.point is None or door.normal is None or not candidates:
        return []
    nx, ny = door.normal.x, door.normal.y
    L = math.hypot(nx, ny)
    if L < 1e-9:
        return []
    nx, ny = nx / L, ny / L
    ox, oy = door.point.x, door.point.y

    hosts = [
        s for s in candidates
        if _point_in_polygon(ox, oy, s.polygon)
    ]
    # Prefer smaller containing spaces first (nested child over parent).
    hosts.sort(key=lambda s: (_polygon_area(s.polygon), s.global_id))

    picked: list[SpaceFootprint] = []
    seen: set[str] = set()
    for space in hosts:
        if space.global_id in seen:
            continue
        seen.add(space.global_id)
        picked.append(space)
        if len(picked) >= 2:
            return picked

    def first_further(dx: float, dy: float) -> SpaceFootprint | None:
        best: tuple[float, SpaceFootprint] | None = None
        for space in candidates:
            if space.global_id in seen:
                continue
            t = _ray_enter_t(ox, oy, dx, dy, space.polygon)
            # Strictly beyond the door: skip the host's t=0 hit.
            if t is None or t <= 1e-6 or t > DOOR_RAY_MAX_M + 1e-9:
                continue
            if best is None or t < best[0] or (
                abs(t - best[0]) <= 1e-9 and space.global_id < best[1].global_id
            ):
                best = (t, space)
        return best[1] if best else None

    for dx, dy in ((nx, ny), (-nx, -ny)):
        if len(picked) >= 2:
            break
        hit = first_further(dx, dy)
        if hit is None or hit.global_id in seen:
            continue
        seen.add(hit.global_id)
        picked.append(hit)

    # Exterior / mid-gap door with no host: allow t=0 hits from the rays.
    if not picked:
        plus = _first_space_along_ray(ox, oy, nx, ny, candidates)
        minus = _first_space_along_ray(ox, oy, -nx, -ny, candidates)
        for hit in (plus, minus):
            if hit is None:
                continue
            space = hit[1]
            if space.global_id in seen:
                continue
            seen.add(space.global_id)
            picked.append(space)
            if len(picked) >= 2:
                break

    return picked


def _pick_second_space_oriented(
    door: DoorPortal,
    ifc_space: SpaceFootprint,
    candidates: list[SpaceFootprint],
) -> SpaceFootprint | None:
    """IFC already linked one space: take the nearest further hit on either ray."""
    if door.point is None or door.normal is None:
        return None
    nx, ny = door.normal.x, door.normal.y
    L = math.hypot(nx, ny)
    if L < 1e-9:
        return None
    nx, ny = nx / L, ny / L
    ox, oy = door.point.x, door.point.y
    skip = {ifc_space.global_id}

    best: tuple[float, SpaceFootprint] | None = None
    for dx, dy in ((nx, ny), (-nx, -ny)):
        for space in candidates:
            if space.global_id in skip:
                continue
            t = _ray_enter_t(ox, oy, dx, dy, space.polygon)
            if t is None or t > DOOR_RAY_MAX_M + 1e-9:
                continue
            # If IFC space already contains the door, require a further hit.
            ifc_contains = _point_in_polygon(ox, oy, ifc_space.polygon)
            if ifc_contains and t <= 1e-6:
                continue
            if best is None or t < best[0] or (
                abs(t - best[0]) <= 1e-9 and space.global_id < best[1].global_id
            ):
                best = (t, space)
    return best[1] if best else None


def _pick_door_spaces(
    door: Point2D, ranked: list[tuple[float, SpaceFootprint]]
) -> list[SpaceFootprint]:
    """
    Legacy (no door normal): at most 2 spaces via between-math.
    Prefer the nearest pair the door sits between; else nearest one-sided.
    """
    if not ranked:
        return []
    if len(ranked) == 1:
        return [ranked[0][1]]

    best: tuple[float, SpaceFootprint, SpaceFootprint] | None = None
    for i, (di, si) in enumerate(ranked):
        for j in range(i + 1, len(ranked)):
            dj, sj = ranked[j]
            if not _door_between_spaces(door, si, sj):
                continue
            score = di + dj
            if best is None or score < best[0]:
                best = (score, si, sj)
    if best is not None:
        return [best[1], best[2]]
    return [ranked[0][1]]


def _pick_second_space_for_ifc_door(
    door: Point2D,
    ifc_space: SpaceFootprint,
    ranked: list[tuple[float, SpaceFootprint]],
) -> SpaceFootprint | None:
    """
    Legacy IFC one-link partner: closest candidate that passes between-math
    with the IFC space.
    """
    best: tuple[float, SpaceFootprint] | None = None
    for dist, space in ranked:
        if space.global_id == ifc_space.global_id:
            continue
        if not _door_between_spaces(door, ifc_space, space):
            continue
        if best is None or dist < best[0] or (
            dist == best[0] and space.global_id < best[1].global_id
        ):
            best = (dist, space)
    return best[1] if best else None


def _line_intersection(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D) -> Point2D:
    """Intersection of infinite lines p1–p2 and p3–p4 (Sutherland–Hodgman helper)."""
    x1, y1 = p1.x, p1.y
    x2, y2 = p2.x, p2.y
    x3, y3 = p3.x, p3.y
    x4, y4 = p4.x, p4.y
    den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(den) < 1e-18:
        return Point2D(x=p2.x, y=p2.y)
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
    return Point2D(x=x1 + t * (x2 - x1), y=y1 + t * (y2 - y1))


def _clip_polygon_convex(
    subject: list[Point2D], clip: list[Point2D]
) -> list[Point2D]:
    """
    Sutherland–Hodgman: clip subject against a convex clip polygon.
    Clip ring is treated as CCW (interior to the left of each edge).
    """
    if len(subject) < 3 or len(clip) < 3:
        return []

    # Ensure clip winds CCW so "inside" is left of edges.
    clip_ring = list(clip)
    if sum(
        (clip_ring[i].x * clip_ring[(i + 1) % len(clip_ring)].y
         - clip_ring[(i + 1) % len(clip_ring)].x * clip_ring[i].y)
        for i in range(len(clip_ring))
    ) < 0:
        clip_ring = list(reversed(clip_ring))

    def inside(p: Point2D, a: Point2D, b: Point2D) -> bool:
        return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -STAIR_INTERSECT_EPS

    output = list(subject)
    for i in range(len(clip_ring)):
        if len(output) < 3:
            return []
        a = clip_ring[i]
        b = clip_ring[(i + 1) % len(clip_ring)]
        input_list = output
        output = []
        prev = input_list[-1]
        for curr in input_list:
            if inside(curr, a, b):
                if not inside(prev, a, b):
                    output.append(_line_intersection(prev, curr, a, b))
                output.append(curr)
            elif inside(prev, a, b):
                output.append(_line_intersection(prev, curr, a, b))
            prev = curr
    return output


def _intersection_area(a: list[Point2D], b: list[Point2D]) -> float:
    """
    Area of a ∩ b. Clips a against convex b (stair hulls are convex);
    falls back to clipping b against a if needed.
    """
    clipped = _clip_polygon_convex(a, b)
    if len(clipped) >= 3:
        return _polygon_area(clipped)
    clipped = _clip_polygon_convex(b, a)
    if len(clipped) >= 3:
        return _polygon_area(clipped)
    return 0.0


def _pick_best_space_for_stair(
    stair_poly: list[Point2D], candidates: list[SpaceFootprint]
) -> SpaceFootprint | None:
    """
    Among intersecting spaces, pick largest Area(stair ∩ space).
    Tie: Area(stair)/Area(space) closest to 1; then smaller global_id.
    """
    stair_area = _polygon_area(stair_poly)
    if stair_area <= STAIR_INTERSECT_EPS:
        return None

    best: SpaceFootprint | None = None
    best_key: tuple[float, float, str] | None = None
    for space in candidates:
        inter = _intersection_area(stair_poly, space.polygon)
        if inter <= STAIR_INTERSECT_EPS:
            continue
        space_area = _polygon_area(space.polygon)
        if space_area <= STAIR_INTERSECT_EPS:
            ratio_dist = float("inf")
        else:
            ratio_dist = abs(stair_area / space_area - 1.0)
        # Sort key: max inter → min ratio_dist → min global_id
        key = (-inter, ratio_dist, space.global_id)
        if best_key is None or key < best_key:
            best_key = key
            best = space
    return best


def _all_complete_spaces(
    footprints: FootprintsDocument,
    excluded_node_ids: set[str] | None = None,
) -> list[SpaceFootprint]:
    excluded = excluded_node_ids or set()
    return [
        s
        for s in footprints.spaces
        if not s.incomplete
        and len(s.polygon) >= 3
        and f"space:{s.global_id}" not in excluded
    ]


def _storey_ids_ordered_by_elevation(footprints: FootprintsDocument) -> list[str]:
    """Storey GlobalIds sorted low→high elevation. Storeys without elevation omitted."""
    with_elev = [
        s for s in footprints.storeys if s.global_id and s.elevation is not None
    ]
    with_elev.sort(key=lambda s: float(s.elevation))  # type: ignore[arg-type]
    return [s.global_id for s in with_elev]


def _point_in_space_footprint(x: float, y: float, space: SpaceFootprint) -> bool:
    """True when (x,y) is in the space exterior and not inside any hole."""
    if len(space.polygon) < 3:
        return False
    if not _point_in_polygon(x, y, space.polygon):
        return False
    for hole in space.holes or []:
        if len(hole) >= 3 and _point_in_polygon(x, y, hole):
            return False
    return True


def _inset_toward_centroid(
    polygon: list[Point2D], inset: float = NESTED_VERTEX_INSET_M
) -> list[Point2D]:
    """
    Ring vertices pulled slightly toward their own centroid.

    A nested room shares walls with its parent, so its corners land exactly on
    the parent outline, where the ray cast decides in/out by ray direction
    rather than geometry. Stepping off the boundary first makes the test read
    the room's interior. Rooms that merely abut the parent step outward from
    it, so they stay excluded.
    """
    n = len(polygon)
    if n < 3:
        return list(polygon)
    cx = sum(p.x for p in polygon) / n
    cy = sum(p.y for p in polygon) / n
    out: list[Point2D] = []
    for p in polygon:
        dx = cx - p.x
        dy = cy - p.y
        d = math.hypot(dx, dy)
        if d < 1e-9:
            out.append(p)
            continue
        # Never step past the centroid on very small rooms.
        t = min(inset, d * 0.5) / d
        out.append(Point2D(x=p.x + dx * t, y=p.y + dy * t))
    return out


def _footprint_contained(child: SpaceFootprint, parent: SpaceFootprint) -> bool:
    """
    True when child sits in the parent's walkable footprint: centroid and most
    ring vertices in parent exterior-minus-holes. Vertices are inset first —
    a shared wall otherwise puts them on the parent outline, where the ray cast
    is ambiguous. Spaces that only sit in a parent hole (courtyard / lift
    shaft) are not nested children.
    """
    if len(child.polygon) < 3 or len(parent.polygon) < 3:
        return False
    probes = _inset_toward_centroid(child.polygon)
    inside = sum(1 for p in probes if _point_in_space_footprint(p.x, p.y, parent))
    if inside / len(probes) < NESTED_CHILD_VERTEX_IN_PARENT:
        return False
    cx = sum(p.x for p in child.polygon) / len(child.polygon)
    cy = sum(p.y for p in child.polygon) / len(child.polygon)
    return _point_in_space_footprint(cx, cy, parent)


def find_nested_parent_gids(footprints: FootprintsDocument) -> set[str]:
    """
    Same-storey spaces that contain at least one smaller nested space.

    These are candidates to remove (near-zero leftover / group label) or
    reduce to parent−children residual corridor. Detection only — callers
    flag graph nodes; they do not rewrite the graph yet.
    """
    by_storey: dict[str | None, list[SpaceFootprint]] = {}
    for space in _all_complete_spaces(footprints):
        by_storey.setdefault(space.storey_global_id, []).append(space)

    parents: set[str] = set()
    for group in by_storey.values():
        areas = {s.global_id: _polygon_area(s.polygon) for s in group}
        for parent in group:
            pa = areas[parent.global_id]
            if pa <= STAIR_INTERSECT_EPS:
                continue
            for child in group:
                if child.global_id == parent.global_id:
                    continue
                ca = areas[child.global_id]
                if ca >= pa * NESTED_CHILD_AREA_RATIO_MAX:
                    continue
                if _footprint_contained(child, parent):
                    parents.add(parent.global_id)
                    break
    return parents


def _annotate_nested_parents(
    nodes: list[GraphNode], footprints: FootprintsDocument
) -> list[GraphNode]:
    parent_gids = find_nested_parent_gids(footprints)
    if not parent_gids:
        return nodes
    out: list[GraphNode] = []
    for node in nodes:
        if node.kind == "space" and node.global_id in parent_gids:
            out.append(node.model_copy(update={"nested_parent": True}))
        else:
            out.append(node)
    return out


def _stair_candidate_storeys(
    footprints: FootprintsDocument, stair_storey_gid: str | None
) -> set[str] | None:
    """
    Storeys an IfcStair may link to: its own + the next higher by elevation.

    Returns None when the stair has no storey (caller should skip linking).
    If elevation order is unknown for this storey, only the own storey is allowed.
    """
    if not stair_storey_gid:
        return None
    ordered = _storey_ids_ordered_by_elevation(footprints)
    allowed: set[str] = {stair_storey_gid}
    try:
        i = ordered.index(stair_storey_gid)
    except ValueError:
        return allowed
    if i + 1 < len(ordered):
        allowed.add(ordered[i + 1])
    return allowed


def _storeys_for_nodes(
    nodes: list[GraphNode], node_ids: set[str]
) -> set[str]:
    """Storey GlobalIds touched by the given graph node ids."""
    out: set[str] = set()
    by_id = {n.id: n for n in nodes}
    for nid in node_ids:
        node = by_id.get(nid)
        if node is not None and node.storey_global_id:
            out.add(node.storey_global_id)
    return out


def build_geometry_graph(
    ifc_graph: ConnectivityGraph,
    footprints: FootprintsDocument,
    *,
    excluded_node_ids: Iterable[str] | None = None,
    only_storeys: Iterable[str] | None = None,
    previous: ConnectivityGraph | None = None,
) -> ConnectivityGraph:
    """
    Superset of the IFC graph: add door↔space, opening space↔space, and
    stair↔space links from footprints when missing from IfcRelSpaceBoundary.

    ``excluded_node_ids`` (e.g. right-click remove) are skipped as heal
    candidates. IFC links to those nodes do not block a replacement heal.

    When ``only_storeys`` is set, inferred edges on other storeys are kept
    from ``previous`` (or rebuilt in full if previous is missing).
    """
    excluded = _normalize_excluded_node_ids(excluded_node_ids)
    storey_filter = {s for s in (only_storeys or []) if s} or None
    if storey_filter is not None and previous is None:
        storey_filter = None

    nodes = list(ifc_graph.nodes)
    edges = [e.model_copy(deep=True) for e in ifc_graph.edges]
    edge_ids = {e.id for e in edges}
    node_by_id = {n.id: n for n in nodes}

    def _inferred_on_filtered_storey(edge: GraphEdge) -> bool:
        """True when a space (or door) endpoint sits on a storey being rehealed."""
        if storey_filter is None:
            return False
        for endpoint in (edge.source, edge.target):
            node = node_by_id.get(endpoint)
            if node is None:
                continue
            if node.kind in {"space", "door"} and node.storey_global_id in storey_filter:
                return True
        return False

    # Keep inferred edges from a previous geometry graph on storeys we are
    # not recalculating (right-click remove → heal that level only).
    if storey_filter is not None and previous is not None:
        for e in previous.edges:
            if not e.inferred:
                continue
            if e.id in edge_ids:
                continue
            if _inferred_on_filtered_storey(e):
                continue
            edges.append(e.model_copy(deep=True))
            edge_ids.add(e.id)

    # Existing portal links (ignore direction). Skip excluded endpoints so
    # an IFC/geom link to a removed node does not block a replacement.
    linked_door_spaces: set[tuple[str, str]] = set()  # (door_id, space_id)
    linked_stair_spaces: set[tuple[str, str]] = set()
    linked_space_pairs: set[tuple[str, str]] = set()  # frozenset-as-sorted tuple
    for e in edges:
        if e.source in excluded or e.target in excluded:
            continue
        if e.kind == "space_door":
            a, b = e.source, e.target
            door = a if a.startswith("door:") else b if b.startswith("door:") else ""
            space = b if door == a else a if door == b else ""
            if door.startswith("door:") and space.startswith("space:"):
                linked_door_spaces.add((door, space))
        if e.kind == "vertical":
            a, b = e.source, e.target
            stair = a if a.startswith("stair:") or a.startswith("lift:") else b
            space = b if stair == a else a
            if space.startswith("space:") and (
                stair.startswith("stair:") or stair.startswith("lift:")
            ):
                linked_stair_spaces.add((stair, space))
        if e.kind == "space_space":
            a, b = e.source, e.target
            if a.startswith("space:") and b.startswith("space:"):
                lo, hi = (a, b) if a < b else (b, a)
                linked_space_pairs.add((lo, hi))

    def _on_heal_storey(storey_gid: str | None) -> bool:
        if storey_filter is None:
            return True
        return bool(storey_gid) and storey_gid in storey_filter

    # --- Door healing ---
    # Cap: a door has at most 2 space links total (IFC ∪ geom).
    #   ≥2 IFC links → skip door entirely
    #   1 IFC link  → add at most one partner
    #   0 IFC links → pick ≤2
    # Oriented doors (normal set): inflate AABB 0.5 m → candidates, then ±ray.
    # Legacy doors (no normal): clearance rank + between-math (old footprints).
    space_fp_by_gid = {
        s.global_id: s for s in _all_complete_spaces(footprints, excluded)
    }
    # Pre-index spaces by storey once instead of rescanning every space in the
    # model for every door — _spaces_for_storey did a full linear scan per
    # call, and this loop runs once per door.
    _spaces_by_storey: dict[str, list[SpaceFootprint]] = {}
    _storey_less_spaces: list[SpaceFootprint] = []
    _all_usable_spaces: list[SpaceFootprint] = []
    for s in space_fp_by_gid.values():
        if f"space:{s.global_id}" not in node_by_id:
            continue
        _all_usable_spaces.append(s)
        if s.storey_global_id is None:
            _storey_less_spaces.append(s)
        else:
            _spaces_by_storey.setdefault(s.storey_global_id, []).append(s)

    def _storey_spaces_cached(storey: str | None) -> list[SpaceFootprint]:
        # Matches _spaces_for_storey's semantics: a None query storey matches
        # every space; a storey-less space matches every query storey.
        if storey is None:
            return _all_usable_spaces
        return _spaces_by_storey.get(storey, []) + _storey_less_spaces

    for door in footprints.doors:
        door_id = f"door:{door.global_id}"
        if door_id not in node_by_id:
            continue
        if door_id in excluded:
            continue
        if door.incomplete or door.point is None:
            continue
        if not _on_heal_storey(door.storey_global_id):
            continue

        existing_space_ids = sorted(
            sid for (did, sid) in linked_door_spaces if did == door_id
        )
        if len(existing_space_ids) >= 2:
            continue

        px, py = door.point.x, door.point.y
        door_pt = Point2D(x=px, y=py)
        storey_spaces = _storey_spaces_cached(door.storey_global_id)

        to_add: list[SpaceFootprint] = []
        if door.normal is not None:
            candidates = _spaces_intersecting_inflated_door(door, storey_spaces)
            if len(existing_space_ids) == 1:
                ifc_gid = existing_space_ids[0].removeprefix("space:")
                ifc_fp = space_fp_by_gid.get(ifc_gid)
                if ifc_fp is None:
                    continue
                partner = _pick_second_space_oriented(door, ifc_fp, candidates)
                if partner is not None:
                    to_add = [partner]
            else:
                to_add = _pick_door_spaces_oriented(door, candidates)
        else:
            ranked: list[tuple[float, SpaceFootprint]] = []
            for space in storey_spaces:
                d = _dist_point_to_polygon(px, py, space.polygon)
                if d > DOOR_CLEARANCE_M:
                    continue
                ranked.append((d, space))
            ranked.sort(key=lambda t: (t[0], t[1].global_id))

            if len(existing_space_ids) == 1:
                ifc_gid = existing_space_ids[0].removeprefix("space:")
                ifc_fp = space_fp_by_gid.get(ifc_gid)
                if ifc_fp is None:
                    continue
                partner = _pick_second_space_for_ifc_door(door_pt, ifc_fp, ranked)
                if partner is not None:
                    to_add = [partner]
            else:
                to_add = _pick_door_spaces(door_pt, ranked)

        for space in to_add:
            space_id = f"space:{space.global_id}"
            if (door_id, space_id) in linked_door_spaces:
                continue
            eid = f"space_door:{space.global_id}:{door.global_id}:geom"
            if eid in edge_ids:
                continue
            edges.append(
                GraphEdge(
                    id=eid,
                    kind="space_door",
                    source=space_id,
                    target=door_id,
                    method="geom_door_space",
                    bidirectional=True,
                    inferred=True,
                )
            )
            edge_ids.add(eid)
            linked_door_spaces.add((door_id, space_id))

    # --- Space↔space heal (interface-first) ---
    # Only link rooms that share a plan interface; openings must lie on that
    # interface. Do not pick "nearest two rooms to an opening" (that crossed walls).
    _heal_space_space_interfaces(
        footprints=footprints,
        node_by_id=node_by_id,
        edges=edges,
        edge_ids=edge_ids,
        linked_space_pairs=linked_space_pairs,
        linked_door_spaces=linked_door_spaces,
        excluded_node_ids=excluded,
        only_storeys=storey_filter,
    )

    # --- Stair / lift healing ---
    # Own storey + next storey up. Per storey: at most one IfcSpace (max ∩ area).
    stairs = list(footprints.stairs or [])
    all_spaces = _all_complete_spaces(footprints, excluded)
    space_by_id = {f"space:{s.global_id}": s for s in all_spaces}

    for stair in stairs:
        stair_id = f"stair:{stair.global_id}"
        if stair_id not in node_by_id:
            continue
        if stair_id in excluded:
            continue
        if stair.incomplete or len(stair.polygon) < 3:
            continue
        candidate_storeys = _stair_candidate_storeys(
            footprints, stair.storey_global_id
        )
        if candidate_storeys is None:
            continue
        heal_storeys = candidate_storeys
        if storey_filter is not None:
            heal_storeys = candidate_storeys & storey_filter
        if not heal_storeys:
            continue

        for storey_gid in heal_storeys:
            # If IFC already linked this stair to any space on this storey, skip.
            already = False
            for sid, spid in linked_stair_spaces:
                if sid != stair_id:
                    continue
                sp = space_by_id.get(spid)
                if sp is not None and sp.storey_global_id == storey_gid:
                    already = True
                    break
                # Fall back to graph node storey if footprint missing from map.
                node = node_by_id.get(spid)
                if (
                    sp is None
                    and node is not None
                    and node.storey_global_id == storey_gid
                ):
                    already = True
                    break
            if already:
                continue

            storey_spaces = [
                s
                for s in all_spaces
                if s.storey_global_id == storey_gid
                and f"space:{s.global_id}" in node_by_id
            ]
            best = _pick_best_space_for_stair(stair.polygon, storey_spaces)
            if best is None:
                continue
            space_id = f"space:{best.global_id}"
            if (stair_id, space_id) in linked_stair_spaces:
                continue
            eid = f"vertical:{stair.global_id}:{best.global_id}:geom"
            if eid in edge_ids:
                continue
            edges.append(
                GraphEdge(
                    id=eid,
                    kind="vertical",
                    source=space_id,
                    target=stair_id,
                    method="geom_stair_space",
                    bidirectional=True,
                    inferred=True,
                )
            )
            edge_ids.add(eid)
            linked_stair_spaces.add((stair_id, space_id))

    annotated = _annotate_nested_parents(nodes, footprints)
    return ConnectivityGraph(
        model_id=ifc_graph.model_id,
        variant="geometry",
        nodes=deepcopy(annotated),
        edges=edges,
    )


def reheal_geometry_graph(
    ifc_graph: ConnectivityGraph,
    footprints: FootprintsDocument,
    *,
    excluded_node_ids: Iterable[str] | None = None,
    previous: ConnectivityGraph | None = None,
) -> ConnectivityGraph:
    """
    Recalculate geometry healing for storeys touched by excluded nodes.

    Other storeys keep their previous inferred edges. Does not persist.
    """
    excluded = _normalize_excluded_node_ids(excluded_node_ids)
    if not excluded:
        if previous is not None:
            return previous
        return build_geometry_graph(ifc_graph, footprints)

    storeys = _storeys_for_nodes(ifc_graph.nodes, excluded)
    if previous is not None:
        storeys |= _storeys_for_nodes(previous.nodes, excluded)
    return build_geometry_graph(
        ifc_graph,
        footprints,
        excluded_node_ids=excluded,
        only_storeys=storeys or None,
        previous=previous,
    )


def _void_portals_on_storey(
    footprints: FootprintsDocument, storey_gid: str
) -> list[VoidPortal]:
    """
    Opening/door portals that may carve wall strips on this storey only.

    Multi-storey IFCs often stack identical door XY on every floor; carving with
    another storey's door would punch false holes through sealed attic walls.

    Only openings that void an ``IfcWall`` may carve: Revit exports cabinet and
    countertop recesses as ``IfcOpeningElement`` too, and those stand against
    walls, so trusting them punches doorways through solid partitions.

    Wall-hosted is not enough on its own — the same entity covers wall-profile
    voids, shafts and duct holes — so voids must also be door-shaped, and they
    carve their own measured extent rather than a fixed radius.
    """
    voids: list[VoidPortal] = []
    for opening in footprints.openings or []:
        if opening.incomplete or opening.point is None:
            continue
        if not opening.host_is_wall:
            continue
        if opening.storey_global_id and opening.storey_global_id != storey_gid:
            continue
        if not _void_is_walkable_shape(opening):
            continue
        voids.append(VoidPortal(point=opening.point, polygon=list(opening.polygon)))
    for door in footprints.doors or []:
        if door.incomplete or door.point is None:
            continue
        if door.storey_global_id and door.storey_global_id != storey_gid:
            continue
        voids.append(VoidPortal(point=door.point))
    return voids


def _heal_space_space_interfaces(
    *,
    footprints: FootprintsDocument,
    node_by_id: dict[str, GraphNode],
    edges: list[GraphEdge],
    edge_ids: set[str],
    linked_space_pairs: set[tuple[str, str]],
    linked_door_spaces: set[tuple[str, str]],
    excluded_node_ids: set[str] | None = None,
    only_storeys: set[str] | None = None,
) -> None:
    """
    Infer walkable space↔space links from facing strips:

    1. Same-storey pairs with a shared plan frontage.
    2. Mark strip samples blocked by wall footprints; carve same-storey
       wall-voiding opening/door portals clear (never other floors' stacked
       doors, never furniture recesses).
    3. Connect when a clear span ≥ MIN_CLEAR_SPAN_M remains
       (no wall / open plan, or partial wall + opening). Full wall seal ⇒ no edge.
    4. Store ``portal`` = centre of the walkable clear frontage for geometric path.

    Skip pairs already linked by the same door. Never opening→nearest-rooms.
    """
    spaces = [
        s
        for s in _all_complete_spaces(footprints, excluded_node_ids)
        if s.storey_global_id and f"space:{s.global_id}" in node_by_id
    ]
    walls = [
        w
        for w in (footprints.walls or [])
        if not w.incomplete and len(w.polygon) >= 3
    ]

    eligible_openings = [
        o
        for o in (footprints.openings or [])
        if _opening_eligible_for_heal(o) and o.point is not None
    ]

    by_storey: dict[str, list[SpaceFootprint]] = {}
    for s in spaces:
        by_storey.setdefault(s.storey_global_id or "", []).append(s)

    walls_by_storey: dict[str | None, list[WallFootprint]] = {}
    for w in walls:
        walls_by_storey.setdefault(w.storey_global_id, []).append(w)

    # Bounding boxes let the O(spaces^2) pair loop below skip the expensive
    # boundary-sampling test (_interface_length_and_gap) for pairs nowhere
    # near each other — the common case on a large floor.
    bbox_by_space: dict[str, tuple[float, float, float, float]] = {}
    for s in spaces:
        bbox = _polygon_bbox(s.polygon)
        if bbox is not None:
            bbox_by_space[s.global_id] = bbox

    for storey_gid, group in by_storey.items():
        if only_storeys is not None and storey_gid not in only_storeys:
            continue
        storey_walls = list(walls_by_storey.get(storey_gid, []))
        storey_walls.extend(walls_by_storey.get(None, []))
        storey_wall_grid = _build_wall_grid(storey_walls)
        void_portals = _void_portals_on_storey(footprints, storey_gid)

        for i, a in enumerate(group):
            a_bbox = bbox_by_space.get(a.global_id)
            for b in group[i + 1 :]:
                a_id = f"space:{a.global_id}"
                b_id = f"space:{b.global_id}"
                lo, hi = (a_id, b_id) if a_id < b_id else (b_id, a_id)
                if (lo, hi) in linked_space_pairs:
                    continue
                if _spaces_already_door_linked(a_id, b_id, linked_door_spaces):
                    continue

                b_bbox = bbox_by_space.get(b.global_id)
                if (
                    a_bbox is not None
                    and b_bbox is not None
                    and not _bboxes_overlap(a_bbox, b_bbox, INTERFACE_GAP_MAX_M)
                ):
                    continue

                length, _mean_gap = _interface_length_and_gap(a, b)
                if length < MIN_INTERFACE_LEN_M:
                    continue

                local_voids: list[VoidPortal] = []
                for portal in void_portals:
                    p = portal.point
                    limit = INTERFACE_GAP_MAX_M + portal.reach()
                    da = _dist_point_to_polygon(p.x, p.y, a.polygon)
                    db = _dist_point_to_polygon(p.x, p.y, b.polygon)
                    if da <= limit and db <= limit:
                        local_voids.append(portal)

                strip_portal = _strip_clear_portal(a, b, storey_wall_grid, local_voids)
                if strip_portal is None:
                    continue

                # Tag an IFC opening on the interface for metadata only.
                # Portal stays the clear-span centre (never furniture/cabinet XY).
                edge_gid: str | None = None
                for opening in eligible_openings:
                    if (
                        opening.storey_global_id
                        and opening.storey_global_id != storey_gid
                    ):
                        continue
                    assert opening.point is not None
                    if _opening_on_interface(opening.point, a, b):
                        edge_gid = opening.global_id
                        break

                eid = (
                    f"space_space:{lo}:{hi}:opening:{edge_gid}:geom"
                    if edge_gid
                    else f"space_space:{lo}:{hi}:strip:geom"
                )
                if eid in edge_ids:
                    continue
                edges.append(
                    GraphEdge(
                        id=eid,
                        kind="space_space",
                        source=lo,
                        target=hi,
                        global_id=edge_gid,
                        method="geom_opening_space",
                        bidirectional=True,
                        inferred=True,
                        portal=strip_portal,
                    )
                )
                edge_ids.add(eid)
                linked_space_pairs.add((lo, hi))


def _opening_eligible_for_heal(opening: OpeningPortal) -> bool:
    if opening.incomplete or opening.point is None:
        return False
    if opening.filled_by_door_global_id:
        return False
    if opening.filled_by_window_global_id:
        return False
    return True
