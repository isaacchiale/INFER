## Purpose

Derives per-storey 2D space footprints and door portal points from IFC so plan views and hierarchical geometric paths can stay inside room polygons without a building-wide navmesh.

## ADDED Requirements

### Requirement: Persist space footprints per model
The system MUST derive 2D footprints for every space that enters the navigation graph (the connectivity-graph space node set) from a stored IFC model and persist them as JSON under the local derived-data directory, keyed by model id, without modifying the source IFC. Footprint derivation MUST NOT be limited to spaces on a single route.

#### Scenario: Build footprints after extract
- **WHEN** a client requests footprint derivation for a stored model that has navigation spaces
- **THEN** the system persists a footprints document that lists storeys and, for each navigation-graph space, a polygon in a documented 2D coordinate system plus the space IFC GlobalId (or an incomplete marker if geometry is missing)
- **AND** the source IFC bytes remain unchanged

#### Scenario: Fetch persisted footprints
- **WHEN** footprints have been built for a model
- **THEN** a client can retrieve the footprints JSON by model id

### Requirement: Door portals join adjacent spaces
The footprints document MUST include door portal points (or short segments) keyed by door IFC GlobalId so geometric paths can cross between space polygons at openings.

#### Scenario: Door portal present for connected door
- **WHEN** a door participates in space connectivity and footprint derivation succeeds for its storey
- **THEN** the footprints document includes a portal for that door GlobalId with coordinates usable for in-polygon routing

### Requirement: Storey association
Each space footprint and door portal MUST be associated with a storey GlobalId (or an explicit null/unknown storey marker) so clients can filter geometry by level.

#### Scenario: Filter footprints by storey
- **WHEN** a client selects a storey GlobalId present in the footprints document
- **THEN** the client can identify the subset of space polygons and door portals belonging to that storey

### Requirement: Deterministic failure signaling
When footprint geometry cannot be derived for a space, the system MUST omit or mark that space as incomplete rather than inventing coordinates, and MUST leave other spaces' footprints intact when possible.

#### Scenario: Space without recoverable footprint
- **WHEN** a space lacks recoverable 2D boundary geometry
- **THEN** that space is absent or flagged incomplete in the footprints document
- **AND** other spaces with valid geometry are still returned
