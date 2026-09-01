## 1. Footprints extract

- [x] 1.1 Extend footprints schema with an `openings` portal list (incl. optional `filled_by_door_global_id`)
- [x] 1.2 Extract `IfcOpeningElement` 2D portals in the footprints builder; resolve fill door/window via `IfcRelFillsElement`
- [x] 1.3 Add unit fixtures/tests for opening extract (with/without fill, incomplete placement)
- [x] 1.4 Extend footprints with `walls` (`IfcWall` hulls) for strip blockage tests

## 2. Geometry healing

- [x] 2.1 Add edge method `geom_opening_space` to backend + FE graph types
- [x] 2.2 Space↔space heal: facing strip − wall hits + opening/door carve; clear span ⇒ connect
- [x] 2.3 Dedup: skip pairs already linked by the same door; label with opening id when present
- [x] 2.4 Wire into existing `build_geometry_graph` and persist as today

## 3. Docs and verification

- [x] 3.1 Unit tests: open-plan (no wall); full wall block; partial wall + opening; no cross-storey
- [x] 3.2 Update `docs/graph-variants.md` for wall-strip heal
- [ ] 3.3 Manual: rebuild footprints + geometry; confirm kitchen↔living / no through-wall junk
