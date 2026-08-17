## ADDED Requirements

### Requirement: Temporary FE consumes footprints and geometric path for floorplan
The temporary frontend MUST be able to request footprints for the active model and combine them with a connectivity route result to display a floorplan route overlay, keeping HTTP access in the API module.

#### Scenario: Overlay after route compute
- **WHEN** the user has a model with footprints and a found route
- **THEN** the UI can obtain footprints via the API module and show the geometric overlay on the Floorplan Viewer

### Requirement: Non-functional 3D storey chrome removed or disabled
The temporary frontend MUST NOT present a storey toggle on the 3D viewer that appears to filter the model but does not. Storey filtering for plans MUST be owned by the Floorplan Viewer.

#### Scenario: 3D chrome has no fake floor filter
- **WHEN** a user inspects the 3D viewer chrome after this change
- **THEN** there is no storey control that claims to filter 3D storeys without implementing that filter
