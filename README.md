# INFER

**Intelligent Navigation and Facility Environment Reasoning**

This repository holds the **backend API** plus a **temporary** Vite IFC viewer under `frontend/` (discard when the real frontend arrives).

## Frontend

Product UI (`INFER_Frontend`) with That Open 3D viewport:

```powershell
cd frontend
npm install
npm run dev
```

**Open model…** in the top bar → drop an `.ifc`. See [frontend/README.md](frontend/README.md).

## Backend quick start

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

- Health: http://127.0.0.1:8000/health
- Details: [backend/README.md](backend/README.md)

## Security (government POC)

- Bind defaults to **127.0.0.1** (localhost only).
- IFC / building models stay on-prem under `data/` — do not upload to cloud BIM SaaS or public LLM APIs.
- Set `CORS_ORIGINS` in `backend/.env` to your external frontend origin when you have it.

## OpenSpec

Planning under `openspec/`. Active change example: `setup-backend`.

Cursor: `/opsx-propose`, `/opsx-apply`, `/opsx-archive`.

## Model API (summary)

- `POST /models` — upload `.ifc`
- `POST /models/{id}/extract` — semantic extract
- `GET /models/{id}/entities` — persisted extract JSON

See [backend/README.md](backend/README.md).

## Next

Connectivity graph API (space–door–vertical), then routing.
