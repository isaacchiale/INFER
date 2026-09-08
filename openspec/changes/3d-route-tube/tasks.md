## 1. Path lift helpers

- [x] 1.1 Add a pure helper that maps a 2D storey polyline + storey elevation (+ optional coordination) to Three.js `{x,y,z}` points (same convention as camera/floorplan pose)
- [x] 1.2 Unit-test the lift helper (identity / Y-up flip / elevation offset) without the viewer

## 2. That Open tube host

- [x] 2.1 Add a disposable `routeTube` group on the That Open runtime with `setRouteTube(points | null)` that disposes prior geometry/materials
- [x] 2.2 Build a blue translucent `TubeGeometry` mesh (CatmullRom or segment chain) flush via elevation + small ε; skip draw when fewer than 2 points

## 3. Wire route → 3D

- [x] 3.1 From the workspace/store, when route + footprints update, compute per-storey polylines and call `setRouteTube` with all storey slices on the route (independent of floorplan active storey)
- [x] 3.2 Clear the tube when route is cleared or no storey has a usable path
- [ ] 3.3 Manually verify on a sample IFC: floorplan polyline and 3D tube align in XY; tubes sit on each floor the route uses; clear route removes all tubes; floorplan storey switch does not hide other floors’ tubes
