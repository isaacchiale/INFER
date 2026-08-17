## Why

The graph and route APIs prove connectivity, but operators still need a **geometric** per-storey floorplan with a believable route overlay. The current 3D floor toggle is non-functional, and the workspace only splits 3D | graph. We need a high-fidelity plan view, a working storey filter, and hierarchical navigation (global space graph + local in-polygon paths) without a full-building navmesh.

## What Changes

- Evolve the workspace to a **three equal panes** layout: **3D** | **Floorplan** | **Graph** side-by-side
- Each pane can **close**, **maximize** to fill the workspace, and **resize** when multiple panes are open; closed panes reopen from a dock/toolbar
- Add a **Floorplan viewer** (fragments orthographic top-down, high visual fidelity) with a **functional storey toggle** (move/remove the non-working control from the 3D chrome)
- Backend: derive and persist **2D space footprints** (+ door portal points) per storey from IFC (`footprints.json` + API)
- Build **level-3 geometric paths**: global route stays graph `node_ids`; local segments stay inside space polygons via door portals (no building-wide navmesh)
- Overlay the geometric polyline on the **floorplan only** (3D path overlay out of scope for this change)
- Temporary FE consumes footprints + route to draw the overlay

## Non-goals

- No full-building navmesh / Recast / GLM product path
- No 3D route polyline / wall-ghosting in this change
- No OS-level pop-out windows (in-app panes only)
- No cloud IFC upload, APS/Forge, or public LLM use of model geometry
- No silent mutation of source IFC

## Capabilities

### New Capabilities

- `space-footprints`: Deterministic 2D footprints (space polygons + door portals) per storey, derived from IFC and persisted for plan/route geometry
- `geometric-path`: Hierarchical path geometry — graph hop list + in-polygon local segments through door portals
- `floorplan-workspace`: Multi-pane workspace (equal thirds) with floorplan viewer, working storey filter, and floorplan route overlay

### Modified Capabilities

- `semantic-extract`: Optionally surface storey/space identifiers needed to join footprints (no requirement to embed heavy polygons inside `entities.json` if they live in `footprints.json`)
- `temp-fe-bridge`: Disposable UI gains multi-pane chrome, floorplan pane, and footprint/path consumers

## Impact

- Backend: footprint extract service, persist under `data/derived/{id}/`, new model API endpoints, tests on sample IFCs
- Frontend: replace/extend `SplitWorkspace`, new floorplan viewer module, path overlay renderer, storey UI moved off 3D
- Shared: GUID traceability between graph nodes, footprints, and fragments
- Dependencies: continue ifcopenshell / That Open / `react-resizable-panels`; avoid new AGPL viewers
