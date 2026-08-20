## 1. Schema and API contract

- [x] 1.1 Add `holes: list[list[Point2D]]` to `SpaceFootprint` (default empty) and extend `method` with outline literal(s); keep `polygon` as exterior
- [x] 1.2 Mirror types in `frontend/src/types/footprints.ts` (holes optional for older JSON)

## 2. Backend outline derivation

- [x] 2.1 Implement mesh→XY triangle edge stitch (or approved union) producing exterior + hole rings; document method in `footprints.py`
- [x] 2.2 Wire `_space_footprint` preference: outline → convex hull → placement bbox → incomplete
- [x] 2.3 Add/adjust backend tests (synthetic rings and/or fixture IFC) for concave exterior and hole persistence
- [x] 2.4 Leave stair footprints on hull unless sharing outline helper is trivial

## 3. Frontend floorplan + path

- [x] 3.1 FloorplanViewer: draw space (and endpoint highlights) with exterior + holes using evenodd (or equivalent)
- [x] 3.2 geometric-path: containment and A* free cells use exterior-minus-holes; update unit tests
- [x] 3.3 Smoke: rebuild footprints for a model and confirm L/voids on plan after hard-refresh

## 4. Verification

- [x] 4.1 Backend tests pass for footprints outline/holes
- [x] 4.2 Frontend geometric-path tests pass
