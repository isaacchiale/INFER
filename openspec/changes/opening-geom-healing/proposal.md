## Why

Open-plan connections (e.g. living ↔ dry kitchen) often have an `IfcOpeningElement` but no door, so the strict IFC graph and current door-only geometry healing miss a real walkable link. We can heal that with our existing footprint rules instead of TopologicPy.

## What Changes

- Extract `IfcOpeningElement` portals into the footprints document (point and/or short segment in world XY), without modifying source IFC
- Extend the **geometry** graph variant to heal space links through openings (especially unfilled / non-door openings), reusing the door between-math / clearance policy where applicable
- Skip openings that are already represented by a healed/IFC-linked door filling the same void (avoid double edges)
- Label new edges with an explicit inferred method (e.g. `geom_opening_space`) so the Graph Viewer can show them green
- Document behaviour in `docs/graph-variants.md`; leave TopologicPy as an unused optional stub / deferred change (do not implement AccessGraph in this change)
- Unit tests for open-plan opening between two spaces, one-sided IFC, and “filled by door → skip”

## Capabilities

### New Capabilities

- `opening-geometry-heal`: Footprint extract + geometry-variant healing for IFC openings as walkable portals between spaces

### Modified Capabilities

- (none under `openspec/specs/` — geometry variant behaviour lives in prior change artifacts; this adds the opening capability)

## Impact

- Backend: footprints schema/builder, `graph_geometry.py`, graph edge method enum, tests, docs
- Frontend: green inferred edges via existing `inferred` styling; optional opening markers on floorplan later (non-blocking)
- Security: on-prem ifcopenshell only; no new cloud deps; inferred edges labelled; source IFC unchanged
- Non-goals: TopologicPy integration; nested-parent corridor split; treating solid wall-touch as walkable
