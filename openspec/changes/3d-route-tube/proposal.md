## Why

The floorplan already shows a geometric route polyline, but the 3D viewer does not — operators must mentally map 2D to the building. Overlaying the same path as a blue tube in the That Open / Three.js scene makes the route spatially obvious on the active storey without a navmesh or GLB export pipeline.

## What Changes

- When a route exists and the active floorplan storey has a usable geometric polyline, show that path in the **3D viewer** as a **blue volumetric tube** flush to that storey’s floor
- Rebuild / clear the tube when the route, footprints, or active storey change
- Reuse the existing 2D geometric path (same XY as the floorplan overlay); lift to 3D with storey elevation + a small height offset
- **Single-storey only** for this change: tube reflects the active storey’s path slice; no stair ramps, multi-floor continuous tubes, or chevron textures yet

## Non-goals

- No GLB/GLM file export or load as the primary path representation
- No multi-storey continuous tube or staircase sloping (deferred)
- No directional chevron texture / walking-mode path follow
- No full-building navmesh / Recast
- No cloud IFC upload, APS/Forge, or public LLM use of model geometry
- No silent mutation of source IFC
- No new heavy dependencies beyond Three.js APIs already available via That Open

## Capabilities

### New Capabilities

- `viewer-route-tube`: 3D blue tube overlay in the That Open viewer for the active storey’s geometric route polyline

### Modified Capabilities

- _(none — geometric path / floorplan overlay requirements stay as-is; this change consumes them)_

## Impact

- Frontend only (temporary FE): That Open runtime gains a disposable path `THREE.Group`; workspace/store wires route + active storey + footprints into 3D points using the existing IFC↔Three coordinate map
- No backend API or `footprints.json` schema change
- Security: no new network services; mesh built client-side from already-local route geometry
