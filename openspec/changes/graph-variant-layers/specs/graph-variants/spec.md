## Purpose

Provides selectable connectivity-graph variants (IFC baseline, geometry-healed, TopologicPy) with explicit inferred-edge provenance for comparison and routing without modifying source IFC.

## ADDED Requirements

### Requirement: Three graph variants per model
The system MUST support three connectivity graph variants for a stored model: `ifc` (strict IFC space-boundary relations), `geometry` (IFC graph plus deterministic door↔space and stair↔space geometric links), and `topologic` (links derived via on-prem TopologicPy analysis). Variants MUST NOT modify the uploaded IFC file.

#### Scenario: IFC variant matches boundary-only graph
- **WHEN** a client requests the `ifc` graph variant for a model that has a persisted boundary graph
- **THEN** the system returns a graph whose edges are limited to IFC-authored boundary relationships (plus any already-labelled IFC methods), with stable node ids tied to IFC GlobalIds

#### Scenario: Geometry variant adds inferred portal links
- **WHEN** a client builds or fetches the `geometry` variant for a model with footprints and an IFC graph
- **THEN** the returned graph includes the IFC baseline edges and MAY include additional door↔space and stair↔space edges labelled as inferred / non-boundary methods

#### Scenario: Topologic variant is on-prem only
- **WHEN** a client builds the `topologic` variant
- **THEN** processing MUST run locally against the stored IFC (or derived geometry) with no cloud upload of model content

### Requirement: Inferred edge provenance
Every edge that is not authored via IFC space-boundary relationships MUST carry an explicit method (and/or inferred flag) so clients can distinguish baseline vs healed links.

#### Scenario: Client can tell green vs grey edges
- **WHEN** a geometry or topologic graph contains both IFC baseline edges and healed edges
- **THEN** healed edges are distinguishable in the JSON payload from baseline edges without relying on edge id string parsing alone

### Requirement: Fetch and build by variant
The system MUST allow clients to request a specific variant and to trigger persistence of derived variant graphs under local derived storage.

#### Scenario: Fetch geometry graph
- **WHEN** the geometry variant has been built for a model
- **THEN** a GET with variant `geometry` returns the persisted geometry graph JSON

#### Scenario: Topologic unavailable
- **WHEN** TopologicPy is not installed or the topologic build fails
- **THEN** the system returns a clear error for that variant without breaking `ifc` or `geometry` access

### Requirement: Route against selected variant
Route computation for a model MUST be able to use a specified graph variant so path results match the graph shown in the viewer.

#### Scenario: Route uses geometry variant
- **WHEN** a client requests a route with variant `geometry` and that graph exists
- **THEN** the shortest path is computed on the geometry graph (including inferred edges when they connect the path)
