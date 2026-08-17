from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


class GraphNode(BaseModel):
    id: str
    kind: Literal["space", "door", "stair", "lift"]
    global_id: str
    name: str = ""
    storey_global_id: str | None = None


class GraphEdge(BaseModel):
    id: str
    kind: Literal["space_door", "vertical"]
    source: str
    target: str
    global_id: str | None = None
    # New graphs only emit ifc_rel_space_boundary. Legacy methods remain
    # accepted so older derived graph.json files still load.
    method: Literal[
        "ifc_rel_space_boundary",
        "same_storey_fallback",
        "vertical_storey_link",
    ]
    bidirectional: bool = True


class ConnectivityGraph(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    model_id: str
    built_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
