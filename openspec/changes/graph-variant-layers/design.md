## Context

See proposal.md — Why. Today `build_connectivity_graph` emits a single boundary-only graph; the Graph Viewer loads that one graph. Footprints already expose space polygons and stair hulls that geometry healing can reuse. TopologicPy is not yet a project dependency.

## Goals / Non-Goals

**Goals:**

- Three selectable graph variants per model: `ifc`, `geometry`, `topologic`
- Shared node id scheme (`space:`, `door:`, `stair:`, `lift:`) so the FE layout/routing switch cleanly
- Edge provenance: baseline IFC edges vs inferred (green in UI)
- On-prem only; source IFC never rewritten

**Non-Goals:**

- Writing healed relations back into the IFC file
- Full open-plan merge / nested-room split heuristics (can extend later on the geometry variant)
- Guaranteeing TopologicPy equals ground truth
- Cloud or SaaS topology services

## Decisions

### 1. Variant id + persistence layout

Store derived graphs as:

- `data/derived/{model_id}/graph.json` — keep as **IFC** variant (backward compatible)
- `data/derived/{model_id}/graph.geometry.json`
- `data/derived/{model_id}/graph.topologic.json`

API: `GET /models/{id}/graph?variant=ifc|geometry|topologic` (default `ifc`).  
Build: `POST /models/{id}/graph` builds IFC; `POST /models/{id}/graph/{variant}` builds a specific variant (or build-all helper).

**Alternative considered:** single file with all variants nested — rejected; harder incremental rebuild and larger payloads.

### 2. Edge model for “green = new”

Each edge keeps `method`. Add optional `inferred: bool` (true when not `ifc_rel_space_boundary`).  
Geometry / Topologic graphs are **superset**: copy IFC nodes+edges, then add inferred edges. FE paints `inferred` (or method ∉ IFC set) green; others grey.

**Alternative considered:** only show inferred edges in green modes — rejected; user needs to see full nav graph with highlights.

### 3. Geometry healing rules (variant `geometry`)

Deterministic, footprint-based:

1. **Door ↔ space:** if door lacks IFC boundary edges, link door to spaces whose polygon contains the door point or whose boundary is within a small clearance of the door point/segment (same storey).
2. **Stair ↔ space:** for each stair hull, on each storey the stair span intersects (or containment storey + adjacent), link stair to spaces whose footprint intersects the stair hull (or within clearance). Prefer circulation-like names when multiple; else all overlapping above area threshold.

Reuse existing footprints document; do not require TopologicPy.

### 4. TopologicPy variant (variant `topologic`)

- Optional dependency; license check before pin (prefer non-AGPL).
- Build cell/adjacency offline from IFC geometry via TopologicPy; map cells back to IfcSpace GlobalIds where possible; emit space–space or space–portal edges with `method: "topologicpy_adjacency"` and `inferred: true`.
- If TopologicPy missing or build fails: API returns structured error; FE keeps dropdown option disabled or shows message — IFC/geometry still work.

**Alternative considered:** defer Topologic to a stub — rejected; user asked for a real third mode, with clear failure path.

### 5. Graph Viewer UX

Dropdown (same chrome pattern as floorplan storey selector):

- IFC relations  
- Geometry rules (doors + stairs)  
- TopologicPy  

On change: fetch variant graph, rebuild Cytoscape layout, clear/recompute route against that variant. Legend: grey = IFC, green = inferred.

### 6. Routing

`POST .../route` accepts `graph_variant` (or client sends embedded graph as today). Prefer server-side variant id so FE does not ship large graphs twice.

## Risks / Trade-offs

- [TopologicPy install/license friction] → Gate behind optional extra; document offline install; fail soft  
- [Geometry false positives (door in wrong space)] → Conservative clearances + method labels; compare in UI  
- [Layout jump when switching variants] → Same nodes where possible; Fit after switch  
- [Build time for Topologic] → Async or progress status; cache derived JSON  

## Migration Plan

1. Existing `graph.json` = `ifc` (no migration)  
2. Ship FE dropdown + IFC/geometry first if Topologic lags  
3. Add Topologic builder when dependency cleared  

Rollback: ignore new query params; FE defaults to IFC.

## Open Questions

- Exact TopologicPy package pin / license sign-off (legal)  
- Whether Topologic edges are space–space only or also portal-mediated (decide during spike; both allowed if labelled)
