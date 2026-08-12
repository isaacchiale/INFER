# INFER Stack Research & Decision Record

**Updated:** 2026-08-06  
**Project root:** `C:\Users\Isaac Chia\INFER`

## Current decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Repo scope | **Backend only** | Frontend developed elsewhere; wire later |
| API | FastAPI (Python 3.11+) | Brief-aligned; ifcopenshell is gold-standard for IFC extract |
| IFC processing | ifcopenshell on-prem | Semantic extract of spaces/doors/stairs/lifts/exits |
| Storage | Local filesystem | POC; no cloud object store |
| Frontend in this repo | **Discarded** | Vite scaffold superseded 2026-08-06 |

## Superseded

| Decision | Previous | Why changed |
| --- | --- | --- |
| Processing | Browser-only | User moved FE elsewhere; backend needed for extract/route APIs |
| App shell | Vite + React in-repo | Discarded; external frontend |

## Still rejected (security)

- Autodesk APS / Forge
- Speckle Cloud (unless self-hosted and approved)
- xeokit without AGPL clearance
- Public LLM APIs with model content

## Next OpenSpec changes

1. `setup-backend` — FastAPI scaffold, health, CORS localhost, data dir
2. Later: IFC ingest + semantic extract + indoor schema + graph + route APIs
