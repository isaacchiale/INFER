from pydantic import BaseModel, Field

from app.schemas.graph import ConnectivityGraph, GraphVariant


class RouteComputeRequest(BaseModel):
    origin_node_id: str
    destination_node_id: str
    blocked_node_ids: list[str] = Field(default_factory=list)
    blocked_edge_ids: list[str] = Field(default_factory=list)
    graph: ConnectivityGraph | None = None
    """When set (and graph body omitted), load this persisted variant for the model."""
    graph_variant: GraphVariant | None = None


class RouteResult(BaseModel):
    found: bool
    origin_node_id: str
    destination_node_id: str
    node_ids: list[str] = Field(default_factory=list)
    edge_ids: list[str] = Field(default_factory=list)
    hops: int = 0
    blocked_node_ids: list[str] = Field(default_factory=list)
    blocked_edge_ids: list[str] = Field(default_factory=list)
    message: str = ""
