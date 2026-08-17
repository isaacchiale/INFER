## Purpose

Turns a topological route (space–door hop list) into a geometric polyline by routing locally inside each space footprint through door portals, without requiring a full-building navmesh.

## ADDED Requirements

### Requirement: Hierarchical path from route and footprints
Given a route result of node ids and a footprints document, the system MUST produce an ordered 2D polyline that follows space→door→space order, with each intra-space segment constrained to that space's polygon when a footprint exists.

#### Scenario: Path through two spaces and a door
- **WHEN** a found route is `[space:A, door:D, space:B]` and footprints include polygons for A and B plus a portal for D
- **THEN** the geometric path includes a segment inside A's polygon ending at D's portal and a segment inside B's polygon starting at D's portal

#### Scenario: Missing footprint for a space on the route
- **WHEN** a route references a space without a usable footprint
- **THEN** the geometric path builder MUST NOT invent a wall-cutting chord through unknown geometry
- **AND** it MUST signal that the geometric path is incomplete for that hop (skip, gap marker, or explicit incomplete status)

### Requirement: Storey-scoped path slices
The geometric path MUST be filterable by storey so a floorplan showing one level can display only the segments belonging to that storey, with vertical transitions identifiable at stair/lift nodes.

#### Scenario: Active storey shows only that floor's segments
- **WHEN** a multi-storey geometric path exists and the client selects storey S
- **THEN** only path segments associated with storey S are returned for overlay on that floorplan
- **AND** a vertical node leaving S is represented as an endpoint or marker on S (not a continuous line through other storeys)

### Requirement: Global topology remains authoritative
Geometric path construction MUST consume the route's node/edge order from the connectivity router; it MUST NOT recompute a different global room sequence.

#### Scenario: Blocked stair changes geometry via graph route
- **WHEN** the connectivity router returns a different `node_ids` list after a blockage
- **THEN** the geometric path is rebuilt from that new hop list and footprints
- **AND** it does not keep the previous geometric polyline
