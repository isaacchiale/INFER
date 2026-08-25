## Purpose

Builds on-prem TopologicPy space-adjacency overlays from stored IFC files, maps results to IFC GlobalIds, and merges inferred edges into the selectable `topologic` connectivity graph without altering source IFC.

## ADDED Requirements

### Requirement: Local TopologicPy adjacency extract
When TopologicPy is available, building the `topologic` variant MUST run adjacency analysis only against the locally stored IFC (or equivalent local path) and MUST NOT upload model content to any external topology or cloud service.

#### Scenario: Successful local build
- **WHEN** TopologicPy is installed and the stored IFC yields resolvable space adjacencies
- **THEN** the system persists a `topologic` graph that is a superset of the IFC baseline nodes/edges plus inferred adjacency edges
- **AND** the source IFC bytes remain unchanged

#### Scenario: Package missing
- **WHEN** TopologicPy is not installed
- **THEN** building the `topologic` variant fails with a clear error that tells the operator to install on-prem after license review
- **AND** `ifc` and `geometry` variants remain usable

### Requirement: GlobalId-mapped inferred edges
Every TopologicPy-derived adjacency that is added to the graph MUST resolve both endpoints to known navigation node ids tied to IFC GlobalIds. Edges that cannot be mapped MUST be dropped (not invented under synthetic ids).

#### Scenario: Mapped space adjacency
- **WHEN** TopologicPy reports adjacency between two spaces whose GlobalIds already exist as `space:` nodes in the IFC graph
- **THEN** the system adds an inferred edge between those nodes with an explicit topologic method / inferred flag

#### Scenario: Unmapped vertex dropped
- **WHEN** TopologicPy returns a vertex that cannot be matched to an IFC GlobalId present in the IFC graph
- **THEN** that vertex and its incident inferred edges are omitted from the persisted `topologic` graph

### Requirement: Portal-mediated links preferred when available
If TopologicPy can expose connecting elements (doors/openings) between spaces, the system MUST prefer emitting links that involve those portal nodes when the corresponding portal already exists in the IFC graph; otherwise it MUST fall back to labelled space↔space adjacency.

#### Scenario: Door portal already in graph
- **WHEN** adjacency is associated with a door GlobalId that already has a `door:` node
- **THEN** inferred edges MAY connect each adjacent space to that door node (portal-mediated) rather than only a direct space↔space edge

#### Scenario: No portal id available
- **WHEN** adjacency is known only as space↔space
- **THEN** the system still adds a labelled space↔space inferred edge between the mapped spaces

### Requirement: Fail soft without fake edges
If TopologicPy is installed but the extract returns no usable mapped adjacencies or raises during analysis, the system MUST fail with a structured error rather than persisting an empty “success” overlay or fabricating placeholder edges.

#### Scenario: Extract yields nothing mappable
- **WHEN** TopologicPy runs successfully but produces zero GlobalId-mapped adjacency pairs
- **THEN** the build fails with an actionable error
- **AND** no `graph.topologic.json` success payload is treated as a valid healed overlay for that attempt
