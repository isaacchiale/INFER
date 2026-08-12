from fastapi import APIRouter, File, HTTPException, UploadFile

from app.config import get_settings
from app.schemas.entities import EntitiesExtract, ModelMetadata
from app.schemas.graph import ConnectivityGraph
from app.services import extract as extract_service
from app.services import graph as graph_service
from app.services import storage

router = APIRouter(prefix="/models", tags=["models"])


@router.post("", response_model=ModelMetadata, status_code=201)
async def upload_model(file: UploadFile = File(...)) -> ModelMetadata:
    settings = get_settings()
    try:
        return await storage.save_upload(settings, file)
    except storage.InvalidIfcUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{model_id}", response_model=ModelMetadata)
def get_model(model_id: str) -> ModelMetadata:
    settings = get_settings()
    try:
        return storage.read_meta(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc


@router.post("/{model_id}/extract", response_model=EntitiesExtract)
def extract_model(model_id: str) -> EntitiesExtract:
    settings = get_settings()
    try:
        storage.read_meta(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc

    path = storage.ifc_path(settings, model_id)
    try:
        result = extract_service.extract_entities(model_id, str(path))
        storage.save_entities(settings, result)
        storage.update_extract_status(settings, model_id, "ready")
        return result
    except Exception as exc:  # noqa: BLE001 - surface parser failures cleanly
        storage.update_extract_status(settings, model_id, "failed")
        raise HTTPException(
            status_code=500, detail=f"IFC extraction failed: {exc}"
        ) from exc


@router.get("/{model_id}/entities", response_model=EntitiesExtract)
def get_entities(model_id: str) -> EntitiesExtract:
    settings = get_settings()
    try:
        storage.read_meta(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc

    try:
        return storage.read_entities(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail="Extract not found. Run POST /models/{id}/extract first."
        ) from exc


@router.post("/{model_id}/graph", response_model=ConnectivityGraph)
def build_graph(model_id: str) -> ConnectivityGraph:
    settings = get_settings()
    try:
        storage.read_meta(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc

    path = storage.ifc_path(settings, model_id)
    try:
        graph = graph_service.build_connectivity_graph(model_id, str(path))
        storage.save_graph(settings, graph)
        return graph
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500, detail=f"Graph build failed: {exc}"
        ) from exc


@router.get("/{model_id}/graph", response_model=ConnectivityGraph)
def get_graph(model_id: str) -> ConnectivityGraph:
    settings = get_settings()
    try:
        storage.read_meta(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc

    try:
        return storage.read_graph(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail="Graph not found. Run POST /models/{id}/graph first.",
        ) from exc
