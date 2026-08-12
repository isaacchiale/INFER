## Why

Semantic extract alone does not prove indoor navigation readiness. We need a space–door–vertical connectivity graph from IFC relationships (with deterministic fallbacks) so routing can follow next.

## What Changes

- Build a navigation graph from a stored IFC + extract (spaces, doors, stairs, lifts)
- Prefer `IfcRelSpaceBoundary` door↔space links; document deterministic same-storey fallback when boundaries are missing
- Vertical edges via stairs/lifts across storeys
- Persist graph JSON under `data/derived/{id}/graph.json`
- API: `POST /models/{id}/graph`, `GET /models/{id}/graph`
- Temporary FE: show graph node/edge counts after extract (modular api client extension)

## Non-goals

- No pathfinding / route API yet
- No navmesh / geometry clearance
- No AI relationship inference

## Capabilities

### New Capabilities

- `connectivity-graph`: Deterministic indoor connectivity graph (space–door–vertical) derived from IFC and persisted as JSON

### Modified Capabilities

- `temp-fe-bridge`: Extend disposable UI to display graph summary after build (optional thin change via same temp FE modules)

## Impact

- New backend service + routes
- Derived artifact `graph.json`
- FE api client gains graph methods
