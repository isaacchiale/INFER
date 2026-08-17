## Purpose

Provides a dockable multi-pane model workspace with a high-fidelity per-storey floorplan, working level filter, and floorplan-only geometric route overlay alongside the existing 3D and graph viewers.

## ADDED Requirements

### Requirement: Three-pane equal workspace
The temporary frontend MUST present three panes — 3D Viewer, Floorplan Viewer, and Graph Viewer — in a horizontal thirds layout (equal default widths) with resizable splits when multiple panes are visible.

#### Scenario: Default layout shows all three
- **WHEN** the user opens the model workspace with default pane state
- **THEN** 3D, Floorplan, and Graph each occupy one third of the workspace side-by-side

### Requirement: Close, maximize, and restore panes
Each pane MUST be closable and maximizable. Closing a pane MUST remove it from the layout so remaining panes expand. Maximizing a pane MUST fill the workspace. Closed panes MUST be reopenable from a persistent dock or toolbar. At least one pane MUST remain open.

#### Scenario: Close graph pane
- **WHEN** the user closes the Graph Viewer
- **THEN** Graph is hidden and the remaining open panes expand to fill the workspace
- **AND** the user can reopen Graph from the dock/toolbar

#### Scenario: Maximize floorplan
- **WHEN** the user maximizes the Floorplan Viewer while other panes are open
- **THEN** Floorplan fills the workspace until restored

### Requirement: Floorplan viewer with functional storey filter
The Floorplan Viewer MUST show a per-storey plan of navigation spaces (footprint polygons) for the active storey. The storey control MUST live on the Floorplan Viewer (not as a non-functional control on the 3D chrome) and MUST change which storey's footprints are shown.

#### Scenario: Toggle storey changes plan
- **WHEN** the user selects storey S in the Floorplan Viewer
- **THEN** the floorplan displays footprint polygons for storey S
- **AND** footprints from other storeys are not shown as the active plan layer

### Requirement: Floorplan route overlay
When a geometric path is available, the Floorplan Viewer MUST overlay the storey-filtered polyline on the plan.

#### Scenario: Route visible on active storey
- **WHEN** a geometric path exists for the active storey
- **THEN** the Floorplan Viewer draws that polyline on top of the plan

#### Scenario: No geometric path
- **WHEN** no route is computed or the geometric path is empty for the active storey
- **THEN** the Floorplan Viewer shows the plan without a route overlay (and MUST NOT crash)
