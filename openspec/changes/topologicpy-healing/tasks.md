## 1. Spike and adapter

- [ ] 1.1 Install TopologicPy in the backend venv (optional; document version) and confirm license metadata for supervisor review
- [ ] 1.2 Spike `IFC.AccessGraph` on a local sample IFC; record GlobalId dictionary keys and whether via-connecting elements map to door/opening ids
- [ ] 1.3 Add a thin adapter helper that returns mapped adjacency pairs / portal triples from a local IFC path (no graph merge yet)

## 2. Graph builder

- [ ] 2.1 Replace the stub in `build_topologic_graph` with adapter + merge; drop unmapped vertices; fail soft if zero mapped edges
- [ ] 2.2 Extend merge helpers to emit portal-mediated `space↔door` inferred edges when door nodes exist; else `space↔space`
- [ ] 2.3 Ensure persistence still writes `graph.topologic.json` via existing variant build path

## 3. Tests and docs

- [ ] 3.1 Unit tests: mapping, unmapped drop, portal vs space↔space merge, unavailable package path
- [ ] 3.2 Optional skip-if-missing live smoke test when TopologicPy + fixture IFC are present
- [ ] 3.3 Update `docs/graph-variants.md` with real AccessGraph behavior, install note, and failure modes

## 4. Manual check

- [ ] 4.1 Build TopologicPy variant for a known model in the UI/API; confirm green inferred edges and that IFC/geometry still work when topologic is missing
