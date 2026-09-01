from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.footprints import Point2D

GraphVariant = Literal["ifc", "geometry", "topologic"]

EdgeMethod = Literal[
    "ifc_rel_space_boundary",
    "same_storey_fallback",
    "vertical_storey_link",
    "geom_door_space",
    "geom_stair_space",
    "geom_opening_space",
    "topologicpy_adjacency",
]

IFC_BASELINE_METHODS: frozenset[str] = frozenset(
    {
        "ifc_rel_space_boundary",
    }
)


class GraphNode(BaseModel):
    id: str
    kind: Literal["space", "door", "stair", "lift"]
    global_id: str
    name: str = ""
    storey_global_id: str | None = None
    """
    True when this space geometrically contains other same-storey spaces
    (candidate to remove or reduce to residual corridor). Geometry variant only;
    nodes are flagged, not removed yet.
    """
    nested_parent: bool = False


class GraphEdge(BaseModel):
    id: str
    kind: Literal["space_door", "vertical", "space_space"]
    source: str
    target: str
    global_id: str | None = None
    method: EdgeMethod
    bidirectional: bool = True
    """True when the edge was not authored via IfcRelSpaceBoundary."""
    inferred: bool = False
    """
    Plan XY for geometric path on space↔space heals: centre of the walkable
    clear span along the shared frontage (used like a door portal).
    """
    portal: Point2D | None = None


class ConnectivityGraph(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    model_id: str
    variant: GraphVariant = "ifc"
    built_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
