## Context

See proposal.md — Why. Today `graph_topologic.build_topologic_graph` only checks `import topologicpy` then raises “not fully wired.” The FE/API already expose variant `topologic` and method `topologicpy_adjacency`. Deterministic footprint healing remains in `graph_geometry.py` as a separate comparable layer.

## Goals / Non-Goals

**Goals:**

- Wire a real extractor using TopologicPy’s IFC access-graph APIs
- Map results onto existing IFC graph node ids; merge via `merge_topologic_edges` (extend if portal-mediated edges need door nodes)
- Keep dependency optional; fail soft with clear errors
- Document install + license caveat in `docs/graph-variants.md`

**Non-Goals:**

- Replacing or deleting the `geometry` variant
- Pinning TopologicPy into mandatory `requirements.txt` before license sign-off
- Stair/lift vertical healing via TopologicPy in this change (space access adjacency first)
- Claiming TopologicPy output is ground truth

## Decisions

### 1. Primary API: TopologicPy IFC access graph

Use `topologicpy.IFC.IFC.AccessGraph` (or equivalent documented entry) on the local IFC path/file handle to obtain space adjacency.

**Defaults for POC:**

- `viaConnectingElements=True` when we want portal vertices (doors/openings) for mapping onto `door:` nodes
- Fall back to `viaConnectingElements=False` (direct space↔space) if via-mode yields nothing mappable
- `includeIsolatedSpaces=True` (vertices without edges are fine; we only merge edges)

**Alternative considered:** `Graph.ByIFCPath` full-element graph — rejected as first path; noisier (walls/sites/etc.) and harder to map to nav portals.

### 2. GlobalId extraction from Topologic dictionaries

Read IFC GlobalId from vertex dictionaries (`guid` / `GlobalId` / ontology keys — probe at spike time). Match only to ids already present in `ifc_graph` nodes. Never create new space nodes from Topologic-only entities in this change.

### 3. Edge emission policy

1. If via-vertex maps to an existing `door:{gid}` → add `space↔door` inferred edges for each adjacent mapped space (kind/method consistent with schema; method `topologicpy_adjacency`, `inferred=true`).
2. Else → add `space↔space` inferred edge via existing `merge_topologic_edges`.
3. Skip duplicates of IFC baseline edges (same endpoints).

**Alternative considered:** always space↔space only — simpler, but weaker for routing that expects door portals; we prefer portals when ids exist.

### 4. Optional dependency layout

- Do not add hard pin to main requirements until license review
- Document: `pip install topologicpy` (version noted after spike)
- Optional: `requirements-topologic.txt` or extras section comment in docs only

### 5. Persistence / API

Reuse existing paths: persist `graph.topologic.json`, same GET/POST variant contracts. No new endpoints.

### 6. Testing strategy

- Unit: mock AccessGraph / adjacency pairs → assert merge + mapping + drop-unmapped
- Integration: `@pytest.mark.skipif(not topologic_available())` smoke on a small fixture IFC if one exists under tests; otherwise document manual smoke on SampleHouse

## Risks / Trade-offs

- [TopologicPy version API drift] → Probe helpers behind thin adapter; pin version in docs after first green smoke  
- [AGPL / license surprise] → Keep optional; flag for legal before default install  
- [AccessGraph slow on large IFCs] → Cache derived JSON; accept slow first build for POC  
- [GUID key naming differs by dictionaryMode] → Spike both `basic` and ontology modes; normalize in one helper  
- [Via-connectors create opening ids not doors] → Resolve opening→door via IFC when needed; else space↔space fallback  

## Migration Plan

1. Implement extractor behind existing `build_topologic_graph`
2. Rebuild topologic variant for models after upgrade
3. Rollback: revert module to stub / uninstall package — IFC + geometry unaffected

## Open Questions

- Exact dictionary key for GlobalId on AccessGraph vertices (confirm during first install spike)
- Whether license allows documenting a recommended pin in-repo before supervisor sign-off (assume docs-only until told otherwise)
