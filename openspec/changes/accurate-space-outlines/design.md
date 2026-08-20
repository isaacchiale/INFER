## Context

See proposal.md for motivation. Today `backend/app/services/footprints.py` builds space polygons via mesh XY **convex hull** (`ifc_mesh_xy_hull`) or placement bbox. The temp Floorplan Viewer and `geometric-path.ts` assume a single simple ring (`polygon`) with no holes. ifcopenshell geom already gives triangulated meshes in world coords.

## Goals / Non-Goals

**Goals:**
- Recover a concave exterior ring (+ holes) from IfcSpace mesh (or better IFC footprint representation if readily available).
- Extend footprints schema with `holes` without breaking readers that only use `polygon`.
- Draw holes correctly in the Floorplan Viewer; treat holes as outside for geometric path containment.

**Non-Goals:**
- Multipolygon / disconnected space parts (defer).
- Changing stair overlay to full outlines in the same pass (optional reuse if cheap; hull OK for stairs v1).
- New cloud services; AGPL geometry stacks.

## Decisions

### 1. Schema: `polygon` + `holes`
- **Choice:** Keep `polygon` as exterior ring; add `holes: list[list[Point2D]]` (default empty). Add method literal e.g. `ifc_mesh_xy_outline`.
- **Why:** Backward compatible for existing footprints.json and FE fields; matches GeoJSON Polygon rings.
- **Alternatives:** Replace `polygon` with MultiPolygon (**BREAKING**); bump `schema_version` to 1.1 (optional later if needed).

### 2. Outline algorithm (mesh-first)
- **Choice:** From ifcopenshell mesh faces, project triangles to XY, union / dissolve into a planar region, extract exterior + inners. Prefer a pure-Python or already-approved dependency path:
  - Primary: use triangle edges → boundary edges (edges used once) → stitch rings; classify rings by area / winding / containment into exterior + holes.
  - If self-intersections or fragmentation are severe, fall back to convex hull (existing) then bbox.
- **Why:** Works on spaces that only have solid geometry (common); no new IFC authoring requirements.
- **Alternatives:** IfcSpace `Representation` footprint curves only (accurate when present, often missing); shapely unary_union of triangles (BSD, clear API — acceptable if added with license note).

### 3. Units and winding
- Keep `ifc_world_xy_metres`. Normalize rings (close optional; FE already closes paths). Prefer CCW exterior / CW holes (or document even-odd fill so winding is less critical for SVG).

### 4. Frontend fill
- **Choice:** SVG `fill-rule="evenodd"` with `M…Z` exterior then each hole as another subpath (or `nonzero` with opposite winding). Same helper for start/end outline highlights.
- **Why:** Minimal change to FloorplanViewer.

### 5. Geometric path
- **Choice:** Extend `pointInPolygon` usage to `pointInSpace(p, exterior, holes)` = inside exterior and not inside any hole. Grid A* free cells use the same predicate. `closestPointOnPolygon` for portals stays on exterior (or nearest walkable boundary — exterior is enough for v1).

### 6. Rebuild
- Operators MUST re-run `POST /models/{id}/footprints` (or ingest) to refresh cached footprints.json; old hull files remain valid until rebuilt.

## Risks / Trade-offs

- [Noisy IFC meshes → jagged / broken outlines] → Simplify rings (Douglas–Peucker-style epsilon in metres); fall back to hull if ring stitch fails.
- [Stacked slabs / multi-storey space solids projecting overlapping XY] → Prefer faces near storey elevation band when elevation is known; else accept POC limitation and document.
- [Perf on large models] → Outline only IfcSpace (not every product); cache footprints.json as today.
- [shapely dependency debate] → Prefer edge-stitch first; add shapely only if union quality demands it (BSD, on-prem OK).

## Migration Plan

1. Ship schema + backend outline + tests.
2. Update FE types, viewer, geometric-path.
3. Rebuild footprints for open models (ingest or POST footprints).
4. Rollback: old clients ignore `holes`; method fallbacks still produce a single ring.

## Open Questions

- Whether stair footprints should use the same outline path in this change or stay hull-only (default: hull-only unless implementation shares code for free).
