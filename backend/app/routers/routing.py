from fastapi import APIRouter, HTTPException

from app.config import get_settings
from app.schemas.route import RouteComputeRequest, RouteResult
from app.services import routing as routing_service
from app.services import storage

router = APIRouter(tags=["routing"])


@router.post("/route/compute", response_model=RouteResult)
def compute_route(body: RouteComputeRequest) -> RouteResult:
    """Pathfind on an inline graph (demo / FE) or a stored model graph."""
    settings = get_settings()
    graph = body.graph

    if graph is None:
        raise HTTPException(
            status_code=400,
            detail="Provide graph in the request body, or use POST /models/{id}/route.",
        )

    try:
        return routing_service.find_shortest_path(
            graph,
            body.origin_node_id,
            body.destination_node_id,
            blocked_node_ids=body.blocked_node_ids,
            blocked_edge_ids=body.blocked_edge_ids,
        )
    except routing_service.RoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/models/{model_id}/route", response_model=RouteResult)
def route_model(model_id: str, body: RouteComputeRequest) -> RouteResult:
    settings = get_settings()
    try:
        storage.read_meta(settings, model_id)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc

    variant = body.graph_variant or "ifc"
    try:
        if body.graph is not None:
            graph = body.graph
        else:
            graph = storage.read_graph(settings, model_id, variant)
    except storage.ModelNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Graph variant '{variant}' not found. "
                f"Run POST /models/{{id}}/graph?variant={variant} first."
            ),
        ) from exc

    try:
        return routing_service.find_shortest_path(
            graph,
            body.origin_node_id,
            body.destination_node_id,
            blocked_node_ids=body.blocked_node_ids,
            blocked_edge_ids=body.blocked_edge_ids,
        )
    except routing_service.RoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
