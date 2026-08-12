# temp-fe-bridge Specification

## Purpose
Provides a disposable, modular browser UI that uploads IFC models to the INFER backend, triggers semantic extract, displays extract summaries, and previews geometry locally in 3D.
## Requirements
### Requirement: Modular temporary frontend layout
The temporary frontend MUST separate API access, 3D viewer, and model-workspace orchestration into distinct modules so the UI can be discarded without rewriting backend contracts.

#### Scenario: API client is isolated
- **WHEN** a developer inspects the frontend source
- **THEN** HTTP calls to the INFER backend live in a dedicated API module (not inside the Three.js viewer component)

### Requirement: Upload and extract via backend
The temporary frontend MUST upload a user-selected IFC file to the backend ingest endpoint and request semantic extraction for the returned model id.

#### Scenario: Successful backend round-trip
- **WHEN** a user selects a valid IFC file while the backend is reachable
- **THEN** the UI shows the returned model id and extract summary (counts for storeys, spaces, doors, stairs, lifts, exit candidates)

#### Scenario: Backend unreachable
- **WHEN** the backend cannot be reached during upload/extract
- **THEN** the UI surfaces a clear error message without crashing the viewer shell

### Requirement: Local 3D preview of the same file
The temporary frontend MUST still load the selected IFC into the local 3D viewer for visual confirmation, independent of backend extract success where possible.

#### Scenario: Viewer loads selected file
- **WHEN** a user selects an IFC file
- **THEN** the 3D viewer attempts to display that model in the browser

### Requirement: Replaceability documentation
The temporary frontend MUST document that it is disposable and that the backend HTTP API is the integration contract for a future frontend.

#### Scenario: README states discard intent
- **WHEN** a developer reads the frontend README
- **THEN** it states the UI is temporary and lists the backend endpoints used

