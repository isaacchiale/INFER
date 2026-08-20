## Why

Floorplan footprints currently use a convex hull (or placement bbox) of IfcSpace mesh XY, so L-shaped and other concave rooms look filled-in and courtyards disappear. Operators need outlines that match the real space volume so the plan view (and later in-polygon paths) are trustworthy.

## What Changes

- Replace mesh XY **convex hull** for IfcSpace with a **2D outline** that preserves concavities (single exterior ring when possible).
- Support **polygons with holes** (exterior + inner rings) for atriums / voids inside a space.
- Persist holes on the footprints document; keep exterior in `polygon` for compatibility.
- Floorplan viewer draws exterior + holes (even-odd / subpaths) so voids read as empty.
- Geometric in-polygon checks treat hole interiors as outside the space.
- Fallback chain unchanged in spirit: outline → placement bbox → incomplete (no invented walls).
- Stairs may keep hull for v1 overlay unless the same outline path is cheap to reuse; doors stay portals (points).
- **Non-goals**: multipolygon / disconnected space parts; full BREP wall-cut floor plans; cloud IFC; Autodesk APS.

## Capabilities

### New Capabilities

- _(none)_

### Modified Capabilities

- `space-footprints`: Accurate concave exterior rings + optional holes; new derivation method(s); schema fields for holes.
- `geometric-path`: Local containment must respect holes (point inside a hole is not inside the space).
- `floorplan-workspace`: Plan drawing must render holes as voids in space fills.

## Impact

- Backend: `app/schemas/footprints.py`, `app/services/footprints.py`, footprint tests / fixtures.
- API: same `POST/GET /models/{id}/footprints` payloads gain `holes` (and new `method` literals); existing clients that ignore unknown fields keep working if they only read `polygon`.
- Frontend (temp): `types/footprints.ts`, `FloorplanViewer.tsx`, `geometric-path.ts` (+ tests).
- Dependencies: prefer stdlib / existing ifcopenshell geom; avoid new cloud services. If a small geometry helper (e.g. shapely) is considered, document license (BSD) and keep optional or vendor carefully for on-prem POC.
