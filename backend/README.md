# INFER backend

Python FastAPI service for INFER. Frontend lives in a separate project and will call this API.

## Setup (Windows PowerShell)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

## Run

From `backend/` with the venv active:

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

- Health: http://127.0.0.1:8000/health
- Interactive docs: http://127.0.0.1:8000/docs

## Model API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/models` | Upload an `.ifc` file (multipart field name: `file`) |
| `GET` | `/models/{model_id}` | Model metadata |
| `POST` | `/models/{model_id}/extract` | Run ifcopenshell semantic extract; persist JSON |
| `GET` | `/models/{model_id}/entities` | Fetch persisted extract |
| `POST` | `/models/{model_id}/graph` | Build space–door–vertical connectivity graph |
| `GET` | `/models/{model_id}/graph` | Fetch persisted graph |

Upload example:

```powershell
curl.exe -F "file=@C:\path\to\building.ifc" http://127.0.0.1:8000/models
```

Extract returns normalised JSON (`schema_version: 1.0`) with `storeys`, `spaces`, `doors`, `stairs`, `lifts`, and `exit_candidates` (deterministic name heuristics). Source IFC bytes are never modified.

## Tests

```powershell
pytest
```

## Data directory

On startup the API ensures `data/models` and `data/derived` exist. Uploaded IFCs and derived extracts stay on-prem — never send models to cloud BIM SaaS or public LLM APIs.
