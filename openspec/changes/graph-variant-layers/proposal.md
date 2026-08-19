## Why

Strict `IfcRelSpaceBoundary` graphs are auditable but often incomplete: stairs rarely bound to spaces, doors may lack boundaries, and open-plan / nested spaces are mis-modelled. Operators need to compare the authored IFC graph against geometry-healed and topology-healed variants in the Graph Viewer—same UX pattern as the floorplan storey dropdown—so they can see which links are inferred versus IFC-authored.

## What Changes

- Add a Graph Viewer dropdown to select among three connectivity variants for the loaded model:
  1. **IFC relations** — current strict boundary graph (baseline)
  2. **Geometry rules** — IFC graph plus stair↔space and door↔space geometric healing; **new** edges drawn green
  3. **TopologicPy** — graph (or edge set) derived via TopologicPy spatial analysis; **new** edges drawn green
- Persist or compute each variant server-side with clear edge provenance (`method` / inferred vs authored)
- Route pathfinding uses the **currently selected** graph variant
- Grey edges = shared with IFC baseline (or all edges on IFC mode); green edges = inferred-only additions on modes 2 and 3
- Never modify the source IFC file; healing writes derived JSON only

## Capabilities

### New Capabilities

- `graph-variants`: Multi-variant connectivity graphs (IFC / geometry-heal / TopologicPy), API selection, edge provenance styling, and Graph Viewer mode switcher

### Modified Capabilities

- `temp-fe-bridge`: Graph Viewer must expose variant selection and render inferred edges distinctly; routing requests must target the selected variant

## Impact

- Backend: new/extended graph build pipelines, optional TopologicPy dependency (on-prem, license review), APIs to list/fetch variants and route against a variant id
- Frontend: Graph Viewer dropdown (analogous to floorplan storey selector), Cytoscape edge styles for inferred vs baseline
- Security: TopologicPy must run locally; no cloud IFC upload; inferred edges labelled; source IFC unchanged
- Non-goals: no Autodesk APS; no silent IFC write-back; no claim that TopologicPy is ground truth
