## ADDED Requirements

### Requirement: Graph variant dropdown
The Graph Viewer MUST provide a dropdown (comparable to the floorplan storey selector) that lists the available connectivity graph variants: IFC relations, geometry rules (door + stair), and TopologicPy.

#### Scenario: User switches variant
- **WHEN** the user selects a different graph variant from the dropdown while a model graph is loaded
- **THEN** the viewer loads that variant’s graph and redraws the connectivity visualization

### Requirement: Inferred edges shown in green
When displaying geometry or TopologicPy variants, the Graph Viewer MUST render inferred (non-IFC-baseline) edges in green and baseline IFC edges in the existing grey style.

#### Scenario: Geometry graph highlights healed links
- **WHEN** the geometry variant is selected and the graph contains inferred door/stair edges
- **THEN** those inferred edges appear green and IFC boundary edges remain grey

#### Scenario: IFC variant uses baseline styling
- **WHEN** the IFC relations variant is selected
- **THEN** edges use the baseline grey styling (no green inferred overlay required)

### Requirement: Routing follows selected variant
Shortest-path requests initiated from the Graph Viewer MUST use the currently selected graph variant.

#### Scenario: Path uses healed stair link
- **WHEN** the geometry variant connects a stair to spaces via inferred edges and the user routes between rooms on different storeys that depend on that stair
- **THEN** the computed path MAY traverse those inferred edges and the path highlight updates on the displayed graph
