## Context

`setup-backend` is archived. FastAPI app lives in `backend/app`. Data dirs `data/models` and `data/derived` already exist on startup. Frontend is external.

## Goals / Non-Goals

**Goals:**
- Multipart upload → local store → extract JSON API
- ifcopenshell-based deterministic extractor module
- Normalised schema versioned in JSON (`schema_version`)
- Pytest with a tiny synthetic IFC built by ifcopenshell

**Non-Goals:**
- Geometry/meshes, Fragments, nav graph, routing
- Streaming huge IFCs / progress websockets (can add later)
- Auth

## Decisions

### 1. Model ID
- **Choice:** UUID4 string folder under `data/models/{id}/model.ifc` + `meta.json`
- **Rationale:** Stable opaque IDs for FE; no filename collisions

### 2. Extract output
- **Choice:** `data/derived/{id}/entities.json`
- **Schema (v1):**
  ```json
  {
    "schema_version": "1.0",
    "model_id": "...",
    "storeys": [{"global_id", "name", "elevation"}],
    "spaces": [{"global_id", "name", "storey_global_id"}],
    "doors": [{"global_id", "name", "storey_global_id"}],
    "stairs": [{"global_id", "name"}],
    "lifts": [{"global_id", "name"}],
    "exit_candidates": [{"global_id", "name", "reason"}]
  }
  ```

### 3. Exit heuristics (deterministic)
- Case-insensitive name/object_type match against: `exit`, `evac`, `fire escape`, `emergency`
- Documented in code; not AI

### 4. API routes
- `POST /models` (multipart file)
- `GET /models/{model_id}`
- `POST /models/{model_id}/extract`
- `GET /models/{model_id}/entities`

### 5. Router modules
- `app/routers/models.py`, `app/services/storage.py`, `app/services/extract.py`, `app/schemas/entities.py`

## Risks / Trade-offs

- **[Risk] ifcopenshell Windows install friction** → Pin a known wheel; fail extract with clear 500/422 message if parser missing
- **[Risk] Incomplete IFC relationships** → Store what exists; readiness/graph later
- **[Risk] Large uploads** → POC accepts full file in memory via UploadFile.spool; document size limits later

## Open Questions

None blocking.
