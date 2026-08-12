## Purpose

Deterministically extracts navigation-relevant IFC entities into a normalised JSON document with IFC GUID traceability for downstream graph and routing work.

## ADDED Requirements

### Requirement: Extract navigation entities
The system MUST extract building storeys, spaces, doors, stairs, lifts (transport elements), and exit-candidate doors from a stored IFC model using deterministic IFC parsing.

#### Scenario: Extract after upload
- **WHEN** a client requests extraction for a stored model that contains IFC entities of interest
- **THEN** the system returns a normalised JSON payload including those entity collections
- **AND** each entity includes an IFC GlobalId when available

### Requirement: Persist derived extract
The system MUST persist the extract result as JSON under the local derived-data directory for later retrieval without re-parsing when unchanged.

#### Scenario: Fetch persisted extract
- **WHEN** extraction has completed for a model
- **THEN** a client can retrieve the persisted extract JSON by model id

### Requirement: Source IFC immutability
Extraction MUST NOT modify the stored source IFC file.

#### Scenario: Source unchanged after extract
- **WHEN** extraction runs successfully
- **THEN** the original uploaded IFC bytes remain unchanged on disk

### Requirement: Exit candidates are labelled heuristically but deterministically
Exit candidates MUST be derived from deterministic rules (for example door names/types containing exit/evac/fire escape markers, or IfcDoor entities with clearly exit-related property values) and MUST be identifiable in the extract payload.

#### Scenario: Exit-related door is listed
- **WHEN** an IFC model contains a door whose name indicates an exit under the documented rules
- **THEN** that door appears in the exit-candidates collection (and remains in doors as well)
