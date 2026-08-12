## Why

We have a working FastAPI ingest/extract API and a disposable Vite IFC viewer. Wiring them together (modularly) proves the backend end-to-end before we replace the frontend, and keeps UI boundaries clear for a later swap.

## What Changes

- Restructure the temporary frontend into modular packages: `api/`, `features/viewer/`, `features/model/`, `config`
- Add a typed HTTP client for `POST /models`, `GET /models/{id}`, `POST .../extract`, `GET .../entities`
- On IFC upload: load locally in the 3D viewer **and** upload to the backend, then run extract and show entity counts/lists
- Vite dev proxy to `http://127.0.0.1:8000` to simplify local CORS
- Document that this frontend is temporary and replaceable

## Non-goals

- No final UI/UX polish or design system
- No connectivity graph / routing UI yet (next OpenSpec backend change)
- No authentication
- No replacing That Open viewer with another engine

## Capabilities

### New Capabilities

- `temp-fe-bridge`: Temporary modular frontend that exercises backend model ingest and semantic extract while previewing IFC in 3D

### Modified Capabilities

- (none)

## Impact

- `frontend/src` layout changes; viewer remains browser-local for geometry
- Backend proven via real HTTP calls from the UI
- Easy deletion of `frontend/` later without touching `backend/`
