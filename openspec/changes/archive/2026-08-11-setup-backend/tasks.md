## 1. Project scaffold

- [x] 1.1 Create `backend/app` package with FastAPI entrypoint
- [x] 1.2 Add pydantic-settings config (host, port, CORS, data dir)
- [x] 1.3 Ensure local `data/` directory exists on startup (gitignored contents)

## 2. API surface

- [x] 2.1 Implement `GET /health` JSON response
- [x] 2.2 Configure CORS middleware from allowlist settings

## 3. Dependencies and docs

- [x] 3.1 Add pinned `backend/requirements.txt` and `.env.example`
- [x] 3.2 Update root README for venv, install, run, and security notes
- [x] 3.3 Update `.gitignore` for Python/venv/data

## 4. Verification

- [x] 4.1 Install deps into a local venv
- [x] 4.2 Run health test (TestClient) successfully
- [x] 4.3 Smoke-check live server health endpoint returns 200
