# INFER Frontend

Product UI from `INFER_Frontend` (shell, panels, routing mock, validation, etc.).

**3D viewport** uses the That Open / web-ifc runtime (same engine as the earlier temporary viewer), not the SVG placeholder.

## Viewer integration

| Piece | Role |
| --- | --- |
| `src/viewer/that-open-runtime.ts` | Isolated That Open bootstrap + IFC load |
| `src/components/viewer/InferModelViewport.tsx` | Mount host + overlays; no placeholder scene |
| `src/components/ingest/IngestDialog.tsx` | Open model → queue IFC bytes for the viewer |
| `public/wasm/`, `public/worker.mjs` | Vendored web-ifc WASM + Fragments worker |

## Run

```powershell
cd "C:\Users\Isaac Chia\INFER\frontend"
npm install
npm run dev
```

Open the app → **Open model…** (top bar) → drop an `.ifc` file.

Optional: run the FastAPI backend on `:8000` (Vite proxies `/api` → backend).

## Built with

- TanStack Start / Router
- React + TypeScript + Tailwind
- That Open Components + web-ifc (viewport only)
