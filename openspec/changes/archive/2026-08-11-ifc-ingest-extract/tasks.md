## 1. Dependencies and schema

- [x] 1.1 Add ifcopenshell and python-multipart to requirements and install in venv
- [x] 1.2 Define Pydantic models for model metadata and entities extract (schema v1)

## 2. Storage and extract services

- [x] 2.1 Implement local model storage (UUID folder, meta.json, preserve original IFC bytes)
- [x] 2.2 Implement ifcopenshell semantic extractor (storeys, spaces, doors, stairs, lifts, exit candidates)
- [x] 2.3 Persist extract JSON under data/derived/{id}/entities.json

## 3. HTTP API

- [x] 3.1 Add POST /models upload endpoint
- [x] 3.2 Add GET /models/{model_id} metadata endpoint
- [x] 3.3 Add POST /models/{model_id}/extract and GET /models/{model_id}/entities
- [x] 3.4 Wire router into FastAPI app

## 4. Tests and docs

- [x] 4.1 Create synthetic IFC fixture via ifcopenshell for tests
- [x] 4.2 Test upload reject non-ifc, upload+extract happy path, source file unchanged
- [x] 4.3 Update backend README with new endpoints
