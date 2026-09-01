## Context

See proposal.md — Why. Today geometry healing covers doors and stairs only (`graph_geometry.py`). Footprints expose `doors` / `stairs` / space polygons but not openings. TopologicPy AccessGraph was considered and deferred: opening heal is in-house ifcopenshell + footprints.

## Goals / Non-Goals

**Goals:**

- Extract opening portals into footprints
- Heal walkable links for openings on the geometry variant
- Deduplicate against doors that fill the same opening
- Keep rules testable and conservative (no wall-touch = walkable)

**Non-Goals:**

- TopologicPy / AccessGraph wiring
- Nested parent → residual corridor surgery
- New graph variant id (stay on `geometry`)
- Requiring FE redesign (green `inferred` is enough for POC)

## Decisions

### 1. Stay on variant `geometry`

Openings extend the existing geometry pipeline and docs, not a fourth dropdown mode.

**Alternative considered:** new `openings` variant — rejected; harder to compare “full geometric heal” as one mode.

### 2. Edge shape for v1: inferred `space_space` (preferred)

For unfilled openings, emit `space_space` edges with `method: "geom_opening_space"` and `inferred: true`, reusing space nodes only.

**Why:** FE/router already understand space↔space; avoids new `opening:` node kind in Cytoscape for the first slice.

**Alternative:** add `opening:` nodes like doors — better long-term for blocking a void; defer unless routing needs to exclude openings independently.

Store `global_id` of the opening on the edge when the schema allows, for traceability.

### 3. Footprints: `openings` list parallel to `doors`

Schema fields analogous to `DoorPortal`: `global_id`, `name`, `storey_global_id`, `point`, `segment`, `incomplete`, `method`, plus optional `filled_by_door_global_id` when `IfcRelFillsElement` resolves a door.

### 4. Heal policy (mirror doors)

Per opening (skip if filled by a door that already has ≥1 space_door link involving that door, or if we detect the door heal already bridges the same two spaces):

- Gather same-storey candidate spaces by clearance / between-math on the opening portal (reuse door helpers with opening point/segment)
- Cap at **2** spaces
- 0 IFC space links via boundaries to this opening → pick ≤2 by geometry
- 1 IFC link → add at most one geometric partner
- ≥2 IFC links → no geometric top-up (same as doors)

IFC opening↔space boundaries are optional enrichment; pure geometry still runs for unfilled openings with 0 boundaries (the open-plan case).

### 5. Dedup with doors

When `filled_by_door_global_id` is set:
- If geometry/IFC already has that door linked to two spaces → skip opening
- If door linked to one space → opening heal may still try the missing partner **or** leave it to door heal only — **prefer leave to door heal** (single code path). Opening heal focuses on **unfilled** openings first.

### 6. Wall-touch

Never add edges from polygon adjacency alone. Opening (or door) portal required.

## Risks / Trade-offs

- [Opening mesh quality poor] → placement fallback + `incomplete`; skip heal if no point  
- [Windows heal as walkable] → restrict to openings not filled by `IfcWindow`, or only unfilled + door-filled skipped; default: heal unfilled openings and door-filled only via door path; **exclude window-filled**  
- [Double edges space_space + door path] → strict fill dedup  
- [space_space bypasses door blocking] → acceptable for open voids; document that excluding a “door” won’t close an opening-only passage  

## Migration Plan

1. Rebuild footprints then geometry graphs for existing models  
2. Rollback: ignore `openings` in heal; old geometry behaviour returns  

## Open Questions

- Whether v1 floorplan should draw opening marks (nice-to-have; not required for graph heal)
- Exact window exclusion rule if some openable windows should count as egress later (default: exclude window-filled)
