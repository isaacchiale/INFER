"""Geometry-based door/stair ↔ space healing on top of an IFC boundary graph."""

from __future__ import annotations

import math
from copy import deepcopy

from app.schemas.footprints import FootprintsDocument, Point2D, SpaceFootprint
from app.schemas.graph import ConnectivityGraph, GraphEdge, GraphNode


DOOR_CLEARANCE_M = 1.0
# Stair links require real footprint ∩ hull (no soft clearance — that linked whole floors).
STAIR_INTERSECT_EPS = 1e-4
# Nested-parent detection (geometry variant highlight only — no removal yet).
NESTED_CHILD_VERTEX_IN_PARENT = 0.85
NESTED_CHILD_AREA_RATIO_MAX = 0.98


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


def _pick_door_spaces(
    door: Point2D, ranked: list[tuple[float, SpaceFootprint]]
) -> list[SpaceFootprint]:
    """
    At most 2 spaces: prefer the nearest pair the door sits between.
    If no valid pair exists, keep only the nearest space (one-sided / exterior).
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
    IFC already linked one space: among other candidates within clearance, pick the
    closest that passes the between-math **with that IFC space** (not vs each other).
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


def _spaces_for_storey(
    footprints: FootprintsDocument, storey: str | None
) -> list[SpaceFootprint]:
    out: list[SpaceFootprint] = []
    for s in footprints.spaces:
        if s.incomplete or len(s.polygon) < 3:
            continue
        if storey is None or s.storey_global_id is None or s.storey_global_id == storey:
            out.append(s)
    return out


def _all_complete_spaces(footprints: FootprintsDocument) -> list[SpaceFootprint]:
    return [
        s
        for s in footprints.spaces
        if not s.incomplete and len(s.polygon) >= 3
    ]


def _storey_ids_ordered_by_elevation(footprints: FootprintsDocument) -> list[str]:
    """Storey GlobalIds sorted low→high elevation. Storeys without elevation omitted."""
    with_elev = [
        s for s in footprints.storeys if s.global_id and s.elevation is not None
    ]
    with_elev.sort(key=lambda s: float(s.elevation))  # type: ignore[arg-type]
    return [s.global_id for s in with_elev]


def _footprint_contained(child: SpaceFootprint, parent: SpaceFootprint) -> bool:
    """
    True when child sits inside parent: centroid in parent and most ring
    vertices in parent. Used to find nested IfcSpace parents without IFC
    CompositionType / RelAggregates.
    """
    if len(child.polygon) < 3 or len(parent.polygon) < 3:
        return False
    inside = sum(
        1 for p in child.polygon if _point_in_polygon(p.x, p.y, parent.polygon)
    )
    if inside / len(child.polygon) < NESTED_CHILD_VERTEX_IN_PARENT:
        return False
    cx = sum(p.x for p in child.polygon) / len(child.polygon)
    cy = sum(p.y for p in child.polygon) / len(child.polygon)
    return _point_in_polygon(cx, cy, parent.polygon)


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


def build_geometry_graph(
    ifc_graph: ConnectivityGraph, footprints: FootprintsDocument
) -> ConnectivityGraph:
    """
    Superset of the IFC graph: add door↔space and stair↔space links from footprints
    when missing from IfcRelSpaceBoundary.
    """
    nodes = list(ifc_graph.nodes)
    edges = [e.model_copy(deep=True) for e in ifc_graph.edges]
    edge_ids = {e.id for e in edges}

    # Existing portal links (ignore direction).
    linked_door_spaces: set[tuple[str, str]] = set()  # (door_id, space_id)
    linked_stair_spaces: set[tuple[str, str]] = set()
    for e in edges:
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

    node_by_id = {n.id: n for n in nodes}

    # --- Door healing ---
    # Cap: a door has at most 2 space links total (IFC ∪ geom).
    #   ≥2 IFC links → skip door entirely
    #   1 IFC link  → add at most one partner that passes between-math WITH that
    #                 IFC space (closest such candidate)
    #   0 IFC links → pick ≤2 via between/nearest as before
    space_fp_by_gid = {
        s.global_id: s for s in _all_complete_spaces(footprints)
    }
    for door in footprints.doors:
        door_id = f"door:{door.global_id}"
        if door_id not in node_by_id:
            continue
        if door.incomplete or door.point is None:
            continue

        existing_space_ids = sorted(
            sid for (did, sid) in linked_door_spaces if did == door_id
        )
        if len(existing_space_ids) >= 2:
            continue

        px, py = door.point.x, door.point.y
        door_pt = Point2D(x=px, y=py)
        ranked: list[tuple[float, SpaceFootprint]] = []
        for space in _spaces_for_storey(footprints, door.storey_global_id):
            space_id = f"space:{space.global_id}"
            if space_id not in node_by_id:
                continue
            d = _dist_point_to_polygon(px, py, space.polygon)
            if d > DOOR_CLEARANCE_M:
                continue
            ranked.append((d, space))
        ranked.sort(key=lambda t: (t[0], t[1].global_id))

        to_add: list[SpaceFootprint] = []
        if len(existing_space_ids) == 1:
            ifc_gid = existing_space_ids[0].removeprefix("space:")
            ifc_fp = space_fp_by_gid.get(ifc_gid)
            if ifc_fp is None:
                # IFC linked a space we have no complete footprint for — cannot
                # run between-math; leave the single IFC link as-is.
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

    # --- Stair / lift healing ---
    # Own storey + next storey up. Per storey: at most one IfcSpace (max ∩ area).
    stairs = list(footprints.stairs or [])
    all_spaces = _all_complete_spaces(footprints)
    space_by_id = {f"space:{s.global_id}": s for s in all_spaces}

    for stair in stairs:
        stair_id = f"stair:{stair.global_id}"
        if stair_id not in node_by_id:
            continue
        if stair.incomplete or len(stair.polygon) < 3:
            continue
        candidate_storeys = _stair_candidate_storeys(
            footprints, stair.storey_global_id
        )
        if candidate_storeys is None:
            continue

        for storey_gid in candidate_storeys:
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
