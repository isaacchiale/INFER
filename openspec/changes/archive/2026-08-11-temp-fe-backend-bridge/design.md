## Context

Backend ingest/extract archived. Temp viewer exists as a single `IfcViewer.tsx`. Frontend will be replaced later.

## Goals / Non-Goals

**Goals:**
- Modular FE structure + typed API client
- Prove `POST /models` + `POST /models/{id}/extract` from the UI
- Keep 3D viewer as a dumb display module (`loadBuffer`)
- Dev proxy `/api` → FastAPI

**Non-Goals:**
- Graph/routing UI
- Production hosting of the temp FE

## Decisions

### 1. Module layout
```
frontend/src/
  config.ts
  api/types.ts
  api/client.ts
  features/viewer/IfcViewer.tsx   # imperative viewer API via ref/callbacks
  features/entities/EntitiesPanel.tsx
  features/model/ModelWorkspace.tsx
  App.tsx
```

### 2. Dev proxy
- Vite `server.proxy["/api"]` → `http://127.0.0.1:8000` with rewrite strip `/api`
- `config.apiBaseUrl = "/api"` in dev

### 3. Upload flow
1. User picks file
2. Workspace reads ArrayBuffer once
3. Viewer loads copy; client uploads `File` to backend
4. Client calls extract; EntitiesPanel renders summary

### 4. Error isolation
- Viewer errors and API errors shown separately so one failure doesn't hide the other

## Risks

- **[Risk] Large IFC doubles memory (viewer + upload)** → Accept for temp POC
- **[Risk] Backend not running** → Clear status text

## Open Questions

None.
