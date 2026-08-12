## Context

See `proposal.md`. Frontend Vite scaffold removed; OpenSpec constitution now says this repo is backend-only. Python 3.11 is available on the machine.

## Goals / Non-Goals

**Goals:**
- FastAPI app under `backend/` with clear package layout
- `GET /health` JSON
- Settings via environment / `.env.example` (localhost, CORS origins, data dir)
- `requirements.txt` with pinned FastAPI/uvicorn versions
- Update root README for backend workflow

**Non-Goals:**
- IFC upload/extract endpoints
- Auth, Postgres, Docker (optional later)
- Shipping a frontend

## Decisions

### 1. Layout: `backend/` package
- **Choice:** `backend/app/main.py`, `backend/app/config.py`, `backend/requirements.txt`
- **Rationale:** Keeps OpenSpec/`docs` at root; FE can live elsewhere as a sibling repo
- **Alternative:** Monorepo `apps/api` — unnecessary for one service

### 2. Settings
- **Choice:** pydantic-settings; defaults `HOST=127.0.0.1`, `PORT=8000`, `CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`, `DATA_DIR=../data` (resolved under repo `data/`)
- **Rationale:** Safe defaults for gov POC; FE origin configurable when Isaac shares it

### 3. No ifcopenshell in this change
- **Choice:** Defer heavy native dependency to `ifc-ingest` / extract change
- **Rationale:** Faster, smaller first backend milestone; avoids install friction on Windows during scaffold

### 4. Tests
- **Choice:** One pytest health test using FastAPI TestClient
- **Rationale:** Deterministic smoke without starting a live server

## Risks / Trade-offs

- **[Risk] CORS origins unknown until FE arrives** → Document `.env` override; start with common Vite localhost ports
- **[Risk] Data dir accumulates sensitive IFC** → gitignore `data/*` except `.gitkeep`; document retention

## Migration Plan

1. Implement scaffold + health
2. Verify pytest + uvicorn
3. Next OpenSpec change: IFC ingest + ifcopenshell extract API
