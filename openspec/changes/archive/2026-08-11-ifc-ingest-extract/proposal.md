## Why

The FastAPI shell is ready. Next we need on-prem IFC ingest and semantic extraction so an external frontend (and later graph/routing) can consume storeys, spaces, doors, stairs, lifts, and exit candidates with IFC GUID traceability.

## What Changes

- Accept IFC file upload and store it under the local `data/models` directory
- Extract navigation-relevant entities with ifcopenshell (deterministic)
- Persist normalised JSON extract under `data/derived`
- Expose HTTP APIs to upload, list/get model metadata, run extract, and fetch entities
- Add a small synthetic IFC fixture for automated tests
- Never modify the uploaded source IFC

## Non-goals

- No 3D geometry mesh generation / viewer payloads
- No connectivity graph or routing yet
- No AI inference of missing relationships
- No cloud storage or third-party BIM SaaS
- No frontend work in this repo

## Capabilities

### New Capabilities

- `ifc-ingest`: Accept and store IFC models on local disk with stable model IDs and metadata
- `semantic-extract`: Deterministic extraction of storeys, spaces, doors, stairs, lifts, and exit candidates into a normalised JSON schema with IFC GUIDs

### Modified Capabilities

- (none — extends the existing API app; `backend-api` health/CORS unchanged)

## Impact

- Adds `ifcopenshell` and `python-multipart` dependencies
- New routes under `/models`
- Local disk growth under `data/models` and `data/derived` (gitignored)
- External FE can upload IFC and poll extract results
