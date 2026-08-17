# INFER Frontend

Temporary product UI (disposable). Backend HTTP API is the long-term integration contract.

**Viewers:** three equal panes — **3D** | **Floorplan Viewer** (orthographic fragments + storey clip; footprints drive the route overlay only) | **Graph Viewer**. Panes can close, maximize, and resize. A full page reload resets pane sizes to equal thirds and clears the in-memory ingest session (upload again to restore a model). Storey filtering lives on the Floorplan pane.

## Viewer integration

| Piece | Role |
| --- | --- |
| `src/viewer/that-open-runtime.ts` | That Open 3D bootstrap + IFC load |
| `src/components/floorplan/FloorplanViewer.tsx` | Ortho fragments plan + storey clip + route overlay |
| `src/viewer/floorplan-runtime.ts` | That Open Plan/Ortho world for the floorplan pane |
| `src/lib/geometric-path.ts` | Level-3 path (graph hops + in-polygon local segments) |
| `src/components/workspace/SplitWorkspace.tsx` | Three equal dockable panes |
| `src/components/ingest/IngestDialog.tsx` | Upload → extract → graph → **footprints** |
| `public/wasm/`, `public/worker.mjs` | web-ifc WASM + Fragments worker |

## Backend endpoints used

- `POST/GET /models`, `/extract`, `/entities`, `/graph`, `/route`
- `POST/GET /models/{id}/footprints` — 2D space polygons + door portals for every navigation space

No full-building navmesh and no 3D path overlay in this slice.

## Run

```powershell
cd "C:\Users\Isaac Chia\INFER\frontend"
npm install
npm run dev
```

Open the app → **Open model…** → drop an `.ifc`. Run FastAPI on `:8000` (Vite proxies `/api`).

## Built with

- TanStack Start / Router
- React + TypeScript + Tailwind
- That Open Components + web-ifc (3D)
- Cytoscape (graph)
- `react-resizable-panels` (workspace)
