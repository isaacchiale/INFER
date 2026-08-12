## Why

This repository now owns the INFER backend only. The frontend will arrive later from elsewhere. We need a FastAPI service scaffold so IFC extraction, graph, and routing APIs have a secure on-prem home.

## What Changes

- Create a Python FastAPI backend package with a health endpoint
- Localhost-first run configuration and documented CORS allowlist for an external frontend
- Local `data/` directory layout for future IFC/model storage (gitignored contents)
- Pinned Python dependencies (`requirements.txt` / lock-friendly pins)
- Backend README / root README updated for API-only workflow
- No IFC parsing yet (next change)

## Non-goals

- No frontend SPA in this repo
- No ifcopenshell extract / routing yet
- No cloud storage, auth provider, or public deployment
- No analytics / third-party model upload

## Capabilities

### New Capabilities

- `backend-api`: On-prem FastAPI service shell — health check, CORS policy for local frontend wiring, local data directory conventions

### Modified Capabilities

- (none)

## Impact

- New Python project under `backend/` (or repo root `app/` — design chooses `backend/`)
- Developers run uvicorn locally; external FE calls `http://127.0.0.1:8000`
- Later changes add `/models`, extract, graph, route routes under the same app
