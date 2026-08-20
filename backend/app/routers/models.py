from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from app.config import get_settings
from app.schemas.entities import EntitiesExtract, ModelMetadata
from app.schemas.footprints import FootprintsDocument
from app.schemas.graph import ConnectivityGraph, GraphVariant
from app.services import extract as extract_service
from app.services import footprints as footprints_service
from app.services import graph as graph_service
from app.services import graph_geometry
from app.services import graph_topologic
from app.services import storage

router = APIRouter(prefix="/models", tags=["models"])

_VARIANT_DETAIL = {
    "ifc": "Graph not found. Run POST /models/{id}/graph?variant=ifc first.",
    "geometry": "Geometry graph not found. Run POST /models/{id}/graph?variant=geometry first.",
    "topologic": "Topologic graph not found. Run POST /models/{id}/graph?variant=topologic first.",
}


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


def _ensure_ifc_graph(settings, model_id: str) -> ConnectivityGraph:
    try:
        return storage.read_graph(settings, model_id, "ifc")
    except storage.ModelNotFoundError:
        path = storage.ifc_path(settings, model_id)
        graph = graph_service.build_connectivity_graph(model_id, str(path))
        storage.save_graph(settings, graph, "ifc")
        return graph


def _ensure_footprints(settings, model_id: str) -> FootprintsDocument:
    try:
        return storage.read_footprints(settings, model_id)
    except storage.ModelNotFoundError:
        path = storage.ifc_path(settings, model_id)
        doc = footprints_service.build_footprints(model_id, str(path))
        storage.save_footprints(settings, doc)
        return doc


@router.post("/{model_id}/graph", response_model=ConnectivityGraph)
def build_graph(
    model_id: str,
    variant: GraphVariant = Query("ifc"),
) -> ConnectivityGraph:
    settings = get_settings()
    try:
        storage.read_meta(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc

    path = storage.ifc_path(settings, model_id)
    try:
        if variant == "ifc":
            graph = graph_service.build_connectivity_graph(model_id, str(path))
            storage.save_graph(settings, graph, "ifc")
            return graph

        ifc_graph = _ensure_ifc_graph(settings, model_id)

        if variant == "geometry":
            footprints = _ensure_footprints(settings, model_id)
            graph = graph_geometry.build_geometry_graph(ifc_graph, footprints)
            storage.save_graph(settings, graph, "geometry")
            return graph

        # topologic
        try:
            graph = graph_topologic.build_topologic_graph(
                model_id, str(path), ifc_graph
            )
        except graph_topologic.TopologicUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        storage.save_graph(settings, graph, "topologic")
        return graph
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500, detail=f"Graph build failed ({variant}): {exc}"
        ) from exc


@router.get("/{model_id}/graph", response_model=ConnectivityGraph)
def get_graph(
    model_id: str,
    variant: GraphVariant = Query("ifc"),
) -> ConnectivityGraph:
    settings = get_settings()
    try:
        storage.read_meta(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc

    try:
        return storage.read_graph(settings, model_id, variant)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail=_VARIANT_DETAIL.get(variant, "Graph not found."),
        ) from exc


@router.post("/{model_id}/footprints", response_model=FootprintsDocument)
def build_footprints(model_id: str) -> FootprintsDocument:
    settings = get_settings()
    try:
        storage.read_meta(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc

    path = storage.ifc_path(settings, model_id)
    try:
        doc = footprints_service.build_footprints(model_id, str(path))
        storage.save_footprints(settings, doc)
        return doc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500, detail=f"Footprints build failed: {exc}"
        ) from exc


@router.get("/{model_id}/footprints", response_model=FootprintsDocument)
def get_footprints(model_id: str) -> FootprintsDocument:
    settings = get_settings()
    try:
        storage.read_meta(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc

    try:
        return storage.read_footprints(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail="Footprints not found. Run POST /models/{id}/footprints first.",
        ) from exc
