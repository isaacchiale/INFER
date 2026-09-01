## Purpose

Derives walkable space connections from IFC openings using footprint geometry, so open-plan voids without doors can appear as inferred edges on the geometry graph without external topology libraries.

## ADDED Requirements

### Requirement: Persist opening portals in footprints
The footprints document MUST include portal geometry for navigation-relevant `IfcOpeningElement` entities (point and/or short segment in the same world XY system as doors), keyed by opening GlobalId, without modifying the source IFC.

#### Scenario: Opening extracted after footprints build
- **WHEN** footprints are built for a stored model that contains openings with usable geometry or placement
- **THEN** the footprints document lists those openings with GlobalId and 2D portal geometry when available
- **AND** openings that cannot be located MAY be marked incomplete rather than inventing coordinates

### Requirement: Geometry variant heals via openings
Building the `geometry` graph variant MUST attempt to link spaces through openings that represent a walkable void, using deterministic footprint rules, and MUST mark such edges as inferred with an opening-specific method.

#### Scenario: Unfilled opening between two spaces
- **WHEN** two same-storey spaces have footprints consistent with a shared opening portal and neither side is already connected solely by a door that fills that opening
- **THEN** the geometry graph includes an inferred walkable link attributable to that opening (space↔space and/or via an opening portal node, as designed)
- **AND** the source IFC remains unchanged

#### Scenario: Opening filled by an already-linked door
- **WHEN** an opening is filled by an `IfcDoor` that already provides IFC or geometry door↔space links covering the same passage
- **THEN** the system MUST NOT add a duplicate opening-heal edge for that void

### Requirement: Conservative cardinality
Opening healing MUST follow a conservative link policy analogous to door healing: prefer at most two space associations per opening void, and MUST NOT treat mere solid-wall adjacency (no opening/door void) as walkable.

#### Scenario: No opening present between adjacent rooms
- **WHEN** two spaces only share a solid wall with no opening/door void in the footprints/IFC portal set
- **THEN** opening healing MUST NOT add a walkable edge between those spaces solely because footprints touch

### Requirement: Fail soft and stay comparable
If opening extract is empty or healing finds no valid pairs, the geometry variant MUST still succeed with existing door/stair healing; missing openings MUST NOT break IFC or geometry builds.

#### Scenario: Model with no openings
- **WHEN** a model has doors/stairs but no usable openings
- **THEN** geometry graph build completes with prior door/stair behaviour only
