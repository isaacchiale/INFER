## Purpose

Builds and persists a deterministic indoor connectivity graph linking spaces, doors, and vertical transitions for later routing and readiness analysis.

## ADDED Requirements

### Requirement: Build connectivity graph
The system MUST build a connectivity graph for a stored model that includes space nodes, door portal nodes, and edges representing space–door adjacency plus vertical transitions for stairs and lifts when detectable.

#### Scenario: Graph from model with spaces and doors
- **WHEN** a client requests graph construction for a model that has been uploaded (and preferably extracted)
- **THEN** the system returns a JSON graph containing nodes and edges with stable ids tied to IFC GlobalIds where applicable

### Requirement: Boundary-first door links
Space–door edges MUST prefer IFC space-boundary relationships when present, and MUST label edges created by fallback heuristics with an explicit method field.

#### Scenario: Fallback edges are labelled
- **WHEN** space boundaries are missing and a same-storey fallback is used
- **THEN** those edges include `method` indicating the fallback (not silent)

### Requirement: Persist graph
The system MUST persist the graph under local derived storage and allow retrieval by model id.

#### Scenario: Fetch persisted graph
- **WHEN** graph construction has completed
- **THEN** `GET` for the model graph returns the persisted JSON
