## 1. Schema and IFC baseline provenance

- [ ] 1.1 Extend graph edge schema with `inferred` (or equivalent) and document allowed `method` values for IFC / geometry / topologic
- [ ] 1.2 Ensure IFC graph builder marks boundary edges as non-inferred; keep `graph.json` as the `ifc` variant
- [ ] 1.3 Add API query/path support to GET/POST graphs by variant (`ifc` | `geometry` | `topologic`)

## 2. Geometry healing variant

- [ ] 2.1 Implement door↔space geometric linking using footprints (point-in-polygon / clearance) for doors missing IFC boundaries
- [ ] 2.2 Implement stair↔space geometric linking using stair hull ∩ space footprints (per storey)
- [ ] 2.3 Persist `graph.geometry.json` as IFC graph ∪ inferred edges; add unit tests with fixture coverage
- [ ] 2.4 Wire route endpoint to accept `graph_variant=geometry` and compute on that graph

## 3. TopologicPy variant

- [ ] 3.1 License/dependency spike: confirm TopologicPy (or approved alternative) is acceptable on-prem; document install
- [ ] 3.2 Implement optional topologic builder that emits inferred edges with `method` labelled topologic; fail soft if missing
- [ ] 3.3 Persist `graph.topologic.json`; add API error contract when unavailable
- [ ] 3.4 Wire route endpoint for `graph_variant=topologic`

## 4. Graph Viewer UI

- [ ] 4.1 Add variant dropdown (IFC / Geometry rules / TopologicPy) mirroring floorplan storey chrome
- [ ] 4.2 Fetch and display selected variant; rebuild Cytoscape; Fit after switch
- [ ] 4.3 Style inferred edges green and baseline edges grey; update legend
- [ ] 4.4 Pass selected variant into route requests; refresh path highlight on the active graph

## 5. Validation

- [ ] 5.1 Manual: same model — compare IFC vs Geometry; green edges only on healed links; multi-storey route appears when stair heal works
- [ ] 5.2 Manual/automated: Topologic absent → clear error; IFC + Geometry still usable
- [ ] 5.3 Confirm source IFC bytes unchanged after all builds
