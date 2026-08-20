## ADDED Requirements

### Requirement: Floorplan draws space holes as voids
When rendering space footprints, the Floorplan Viewer MUST draw each space's exterior ring and MUST render any holes as unfilled voids inside that fill (so courtyards read as empty on the plan).

#### Scenario: Courtyard appears empty on plan
- **WHEN** the active storey includes a space footprint with at least one hole
- **THEN** the Floorplan Viewer shows the space fill with the hole region not filled as room area

#### Scenario: Simple room without holes unchanged
- **WHEN** a space footprint has an exterior and no holes
- **THEN** the Floorplan Viewer fills the exterior polygon as today
