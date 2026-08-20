## ADDED Requirements

### Requirement: In-polygon path respects footprint holes
When a space footprint includes holes, geometric path construction MUST treat points inside any hole as outside that space. Local segments MUST remain in the exterior-minus-holes region when a usable footprint exists.

#### Scenario: Path does not cross a courtyard hole
- **WHEN** a route traverses a space whose footprint has a hole and portals lie in the walkable band around the hole
- **THEN** the geometric path segments for that space do not enter the hole interior
- **AND** containment tests used for local routing classify hole interiors as not inside the space
