## ADDED Requirements

### Requirement: Concave exterior footprints from IfcSpace
When deriving a space footprint from IFC geometry, the system MUST produce an exterior ring that preserves concavities of the space's horizontal extent (for example an L-shaped room MUST NOT be replaced by its convex hull when a concave outline can be recovered). Placement-bbox and incomplete fallbacks remain allowed when an outline cannot be recovered.

#### Scenario: L-shaped space keeps indent
- **WHEN** an IfcSpace has recoverable 2D geometry whose horizontal extent is L-shaped
- **THEN** the persisted exterior polygon follows the L (including the inner corner)
- **AND** the footprint is not marked as using convex-hull-only filling of the L

#### Scenario: Outline unavailable still falls back
- **WHEN** a concave outline cannot be recovered for a space but a placement bbox can
- **THEN** the system MAY persist a bbox polygon with an explicit bbox method
- **AND** MUST NOT invent wall-cutting coordinates beyond that fallback

### Requirement: Holes inside space footprints
A space footprint MUST support zero or more inner rings (holes) representing voids inside the exterior (for example an atrium). Hole rings MUST be persisted with the footprints document alongside the exterior polygon. Clients that only read the exterior polygon remain valid; holes MUST be empty or omitted when none exist.

#### Scenario: Space with courtyard hole
- **WHEN** an IfcSpace outline includes an interior void recoverable as a closed ring
- **THEN** the footprints document includes that void as a hole for the space
- **AND** the exterior ring still encloses the walkable area

#### Scenario: Space without voids
- **WHEN** a space has a valid exterior and no recoverable voids
- **THEN** the footprints document lists no holes for that space (empty list or omitted equivalent)
