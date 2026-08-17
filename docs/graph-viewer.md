# Graph Viewer

The Graph Viewer is one of the three equal workspace panes (3D | Floorplan | Graph). It shows the **semantic connectivity graph** of an ingested IFC (rooms + vertical portals + links), lets you pick Start/Target, and highlights the **NetworkX shortest path** from the backend. It is separate from the That Open 3D viewer; both share the same ingest session.

## Data pipeline

1. **Ingest** uploads the IFC → `extract` entities → `build graph` on the backend.
2. Result is stored in React state via `setModelGraph({ modelId, graph, entities })`.
3. Refresh clears it (in-memory only; no session restore).
4. Empty state shows “No graph loaded” / `—` until ingest succeeds.

### Canonical graph (backend)

- **Nodes:** `space`, `door`, `stair`, `lift`
- **Edges:** only from `IfcRelSpaceBoundary` (`method=ifc_rel_space_boundary`): `space_door` for doors, `vertical` for stair/lift when the IFC links them. No same-storey name chains or stair/lift stars.
- **Storeys** are metadata on spaces, not graph nodes

## Display transform (not the routing graph)

For readability the UI does **not** draw every door node:

1. **`toDisplayGraph`** — keeps `space` / `stair` / `lift`; hides doors; collapses `space–door–space` into direct viz edges.
2. **`deriveStoreyBands`** — levels from extract storeys (by elevation, high → low), plus “Unassigned” if needed.
3. **`buildGraphLayout`** — level-banded preset layout (rooms in a grid per storey; stairs/lifts as side portals; level name labels).

Routing still uses the **full** backend graph (including doors).

## Cytoscape runtime

`frontend/src/viewer/cytoscape-runtime.ts` mirrors the That Open pattern:

- Create **once** on a real-sized container (`waitForSize`)
- Own **ResizeObserver**; destroy once
- **Do not** remount on every route tick

**Framing:** nodes stay in layout model coordinates. Load / resize / **Fit** only change Cytoscape viewport zoom and pan (`cy.fit`) — they never rewrite node positions or sizes.

### Interaction

- Scroll → zoom
- Drag background → pan
- Click a **space** → sets Start, then Destination (alternating)

### Styling (Cosmograph-inspired)

- Spaces = muted slate/grey circles; stairs/lifts = warm terracotta/peach rounded rects
- Solid edges = low-contrast room links; dashed verticals = quiet background (low opacity)
- Shortest-path edges/nodes dominate (bold accent stroke + underlay ring)
- Theme follows light/dark via `graphPalette`

## Pathfinding UI

- Dropdowns (and clicks) choose `origin` / `destination` space IDs.
- Viewer calls `POST /models/{id}/route` when a backend model is loaded (else inline `POST /route/compute` with the graph body).
- Footer shows room count, link count, hop count (or `—` / message if no path).
- Path highlight updates via `setPath` without rebuilding the whole graph.

## Main modules

| Piece | Job |
|--------|-----|
| `frontend/src/components/graph/GraphViewer.tsx` | React chrome, route state, boots runtime |
| `frontend/src/viewer/cytoscape-runtime.ts` | Cytoscape lifecycle, frame, theme, path |
| `frontend/src/lib/graph-layout.ts` | Bands, door collapse, preset positions |
| `frontend/src/api/models.ts` | upload / extract / graph / model route |
| `frontend/src/api/routing.ts` | inline route compute |
| `backend/app/services/graph.py` | Build connectivity from IFC |
| `backend/app/routers/routing.py` + `services/routing.py` | NetworkX pathfinding |

## Scope

- **Is:** topology viz + shortest-path demo over IFC connectivity
- **Isn’t:** geometric floorplan, navmesh, or blockage simulation UI (those can plug into the same route API later via blocked node/edge IDs)
