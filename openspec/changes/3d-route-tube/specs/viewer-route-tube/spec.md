## Purpose

Shows the geometric navigation route as blue volumetric tube(s) in the 3D IFC viewer so operators can see the same path they see on the floorplan, on every storey the route uses — independent of the floorplan level filter.

## ADDED Requirements

### Requirement: Route tube in 3D for every storey on the path
When a found route and footprints yield usable geometric polylines, the 3D viewer MUST display a blue volumetric tube for **each storey** that has at least two distinct path points on that route. The floorplan’s active storey selection MUST NOT hide tubes on other storeys.

#### Scenario: Multi-storey route shows a tube per floor
- **WHEN** a route spans two or more storeys and each has a usable geometric path slice
- **THEN** the 3D viewer shows a separate blue tube on each of those storeys
- **AND** changing the floorplan active storey does not remove tubes on other storeys

#### Scenario: Single-storey route shows one tube
- **WHEN** a route only has path geometry on one storey
- **THEN** the 3D viewer shows exactly that storey’s tube

#### Scenario: Tube sits flush to each storey floor
- **WHEN** a tube is shown for storey S
- **THEN** that tube’s height is at S’s floor elevation plus a small positive offset so it reads as resting on the slab

### Requirement: Tube lifecycle follows route
The 3D tube(s) MUST update or clear when the route or footprints change so they never show a stale path. They MUST NOT depend on the floorplan active storey for visibility.

#### Scenario: Clearing the route removes all tubes
- **WHEN** the user clears the route (or no route is found)
- **THEN** all 3D route tubes are removed from the viewer

#### Scenario: Incomplete geometric path on a storey
- **WHEN** the geometric path for a storey is incomplete or has fewer than two points
- **THEN** the system MUST NOT draw a tube for that storey
- **AND** other storeys with valid slices MAY still show tubes

### Requirement: No invented stair ramps
Each tube MUST represent one storey’s path slice only. The system MUST NOT draw continuous vertical stair/lift ramps or a single CatmullRom spanning multiple storey elevations.

#### Scenario: Vertical hops stay as separate floor slices
- **WHEN** the topological route includes a stair or lift between storeys
- **THEN** each storey’s tube ends at the vertical transition’s plan position on that storey
- **AND** no tube slopes from one storey elevation to another
