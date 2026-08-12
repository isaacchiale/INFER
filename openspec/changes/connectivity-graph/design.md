## Context

Extract API exists. Temp FE can upload/extract. Next per plan: connectivity graph before routing.

## Goals / Non-Goals

**Goals:** Graph schema v1, builder, persist, API, FE summary, tests  
**Non-Goals:** Pathfinding, costs, blockages UI

## Decisions

### Graph schema v1
```json
{
  "schema_version": "1.0",
  "model_id": "...",
  "nodes": [{"id","kind","global_id","name","storey_global_id?"}],
  "edges": [{"id","kind","source","target","global_id?","method","bidirectional"}]
}
```
Kinds: `space` | `door` | `stair` | `lift`  
Edge kinds: `space_door` | `vertical`

### Methods
- `ifc_rel_space_boundary`
- `same_storey_fallback`
- `vertical_storey_link`

### Vertical
For each stair/lift, connect all space nodes on distinct storeys that share containment with that element’s storey set — POC: link every pair of storeys that have spaces, through the stair/lift node (star topology).

## Risks
Incomplete IFC boundaries → many fallback edges (acceptable if labelled)
