## Context

See proposal.md for motivation. Today: connectivity graph + NetworkX routes return topological `node_ids` only; Cytoscape highlights hops; That Open loads IFC→fragments in the browser; `SplitWorkspace` is a 2-pane 3D|Graph split; `FloorSelector` writes `activeStoreyId` but does not clip 3D. Extract/graph JSON have no footprints.

Constraints: on-prem IFC, GUID traceability, modular engines, temp FE disposable, prefer MIT/MPL/LGPL.

## Goals / Non-Goals

**Goals:**
- 2+1 dockable workspace (close / maximize / resize) → **superseded:** equal thirds horizontal
- High-fidelity floorplan via fragments ortho + real storey filter
- Backend footprints + hierarchical geometric path (graph global, polygon local)
- Floorplan-only route overlay

**Non-Goals:**
- Building-wide navmesh, 3D path overlay, OS pop-out windows, IFC mutation

## Decisions

### 1. Footprints on the backend (ifcopenshell), not only from fragments
- **Choice:** Persist `data/derived/{id}/footprints.json`; API `POST/GET .../footprints`
- **Scope:** Compute a footprint for **every space that enters the navigation graph** (same population as graph `space:` nodes / extract spaces used for connectivity) — not the whole IFC product set, and not only spaces on the current route. Door portals for graph doors are included so level-3 paths can cross openings.
- **Why:** Reusable by any client; deterministic; avoids coupling path math to WebGL lifecycle; route changes/blockages reuse the same artifact
- **Alternatives:** Browser-only mesh projection (faster demo, weaker contract); embed huge polygons in `entities.json` (bloated extract); footprints only for the active route (too narrow — rebuild pressure on every reroute)

### 2. Hierarchical navigation (level 3), not full navmesh
- **Choice:** NetworkX remains global; FE (or thin helper) builds in-polygon segments via door portals
- **Why:** Matches space-based product story; avoids Recast/Detour scope
- **Alternatives:** Centroid chords (cuts walls); full navmesh (heavy)

### 3. Local in-space solver for POC
- **Choice:** Start with coarse grid A* (or equivalent) inside each space polygon between portal points; inset slightly from edges
- **Why:** Stays inside polygon; simple to test; upgradeable to funnel/medial axis later
- **Alternatives:** Pure centroid→door lines (can clip); medial axis first (prettier, more code)

### 4. Geometric path assembly on the FE first
- **Choice:** Module `geometric-path` in temp FE consumes route + footprints; optional backend endpoint later
- **Why:** Fast iteration with floorplan; HTTP contract for footprints stays backend-owned
- **Alternatives:** Backend `/route/geometry` immediately (better for external FE later — phase 2)

### 5. Floorplan display = SVG footprints (plan) + fragments reserved for 3D
- **Choice:** Floorplan pane draws **backend footprints** (space polygons + door portals) in SVG with pan/zoom; route overlay shares the same `ifc_world_xy_metres` frame. Fragments orthographic plan was tried and rejected for POC: model frame ≠ footprints XY, storey clipping unreliable, path floated outside the building.
- **Why:** Path and rooms stay aligned; storey filter is exact (filter by `storey_global_id`); no second IFC→fragments convert
- **Tradeoff:** Plan shows space outlines, not full wall BIM fidelity — acceptable for navigation POC; fragments stay in the 3D pane
- **Alternatives:** Fragments ortho + clip (failed alignment); shared FragmentsManager later if we re-attempt high-fidelity plan

### 6. Workspace chrome = extend `react-resizable-panels`
- **Choice:** Single horizontal PanelGroup `[3D | Floorplan | Graph]` with equal default sizes; dock toggles for closed panes; maximize = hide siblings
- **Why:** Already in tree; matches equal-thirds request (replaces earlier 2+1 nested stack)
- **Alternatives:** CSS grid only; mosaic library (new dependency)

### 7. Move storey UI to Floorplan; remove fake 3D control
- **Choice:** Delete/disable non-functional `FloorSelector` on 3D; implement filter on floorplan
- **Why:** Spec honesty; storey filtering matters for plan + path slice

## Risks / Trade-offs

- [Poor IFC space boundaries] → Incomplete footprints; mark gaps; fall back to no overlay for those hops
- [Two WebGL views memory] → Prefer one load / careful dispose; degrade floorplan to footprint SVG if needed
- [Grid path ugly in huge atria] → Accept for POC; document upgrade path
- [Storey mapping ambiguous] → Use extract storey GlobalIds + elevation heuristics; document failures
- [Temp FE vs “backend-only” constitution] → Explicitly temp-fe-bridge; APIs designed for external FE

## Migration Plan

1. Ship footprints API + tests on sample IFC
2. Ship multi-pane chrome (can land before overlay)
3. Floorplan ortho + storey filter
4. Geometric path module + overlay
5. Remove fake 3D floor control
6. Rollback: feature-flag panes / keep prior 2-pane layout behind flag if needed

## Open Questions

- Exact ifcopenshell footprint primitive (space boundary 2D vs bbox fallback) — resolve during first footprint spike without changing specs
- Whether floorplan shares one FragmentsManager instance with 3D or uses a second lightweight world — resolve in implementation for perf
