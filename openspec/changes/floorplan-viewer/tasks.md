## 1. Backend footprints schema and persistence

- [x] 1.1 Define Pydantic schemas for footprints document (storeys, space polygons, door portals, GlobalIds, incomplete flags)
- [x] 1.2 Add storage helpers to read/write `data/derived/{id}/footprints.json` without touching source IFC
- [x] 1.3 Add `POST /models/{id}/footprints` and `GET /models/{id}/footprints` routes (localhost CORS unchanged)

## 2. Footprint derivation from IFC

- [x] 2.1 Spike ifcopenshell 2D footprint extraction for spaces (boundary vs bbox fallback); document chosen method in code comments / service docstring
- [x] 2.2 Implement space polygon derivation keyed by GlobalId + storey association
- [x] 2.3 Implement door portal points/segments joined to storeys and GlobalIds
- [x] 2.4 Mark spaces without recoverable geometry as incomplete; keep successful spaces
- [x] 2.5 Add backend tests with fixture IFC covering happy path + incomplete space behavior

## 3. Multi-pane workspace (thirds)

- [x] 3.1 Replace/extend `SplitWorkspace` into three equal horizontal panes: 3D | Floorplan | Graph using `react-resizable-panels`
- [x] 3.2 Add per-pane close / maximize / restore and a dock/toolbar to reopen closed panes (keep ≥1 pane open)
- [x] 3.3 Persist pane open state and sizes via panel `autoSaveId`s
- [x] 3.4 Wire `index` route to the new workspace shell

## 4. Floorplan viewer + storey filter

- [x] 4.1 Create Floorplan viewer module (orthographic fragments top-down + storey clip; footprints used for route overlay) that loads the ingested IFC
- [x] 4.2 Implement functional storey filter (show active storey geometry only) driven by extract storeys
- [x] 4.3 Move storey UI onto the Floorplan pane; remove non-functional 3D `FloorSelector` chrome
- [x] 4.4 Handle empty model / no storeys gracefully

## 5. Geometric path (level 3) + floorplan overlay

- [x] 5.1 Add FE API client methods for footprints build/fetch
- [x] 5.2 Implement geometric-path module: route `node_ids` + footprints → in-polygon segments via door portals (grid/inset A* POC)
- [x] 5.3 Support storey-filtered path slices and incomplete-hop signaling when footprints missing
- [x] 5.4 Overlay polyline on Floorplan for the active storey; no overlay when empty/incomplete
- [x] 5.5 Hook overlay to existing graph/route compute flow (rebuild when route changes)
- [x] 5.6 Add unit tests for geometric-path helper (two spaces + door; missing footprint)

## 6. Ingest wiring and docs

- [x] 6.1 After extract/graph (or explicit action), build footprints for the model so the floorplan path can load
- [x] 6.2 Update temp FE README / short note: panes, footprints endpoint, no 3D path yet, no full navmesh
- [ ] 6.3 Manual smoke: upload IFC → three panes → switch storeys → compute route → polyline on plan
