from pydantic import BaseModel, Field

from app.schemas.graph import ConnectivityGraph


class RouteComputeRequest(BaseModel):
    origin_node_id: str
    destination_node_id: str
    blocked_node_ids: list[str] = Field(default_factory=list)
    blocked_edge_ids: list[str] = Field(default_factory=list)
    graph: ConnectivityGraph | None = None


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
