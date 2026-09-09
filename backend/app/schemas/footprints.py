from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


class Point2D(BaseModel):
    x: float
    y: float


class StoreyFootprintMeta(BaseModel):
    global_id: str
    name: str = ""
    elevation: float | None = None  # metres (SI), not project mm


class SpaceFootprint(BaseModel):
    """2D plan polygon for a navigation-graph space (XY metres, IFC world)."""

    global_id: str
    name: str = ""
    storey_global_id: str | None = None
    # Exterior ring in XY; empty when incomplete.
    polygon: list[Point2D] = Field(default_factory=list)
    # Inner rings (voids / atriums). Empty when none.
    holes: list[list[Point2D]] = Field(default_factory=list)
    incomplete: bool = False
    method: Literal[
        "ifc_mesh_xy_outline",
        "ifc_mesh_xy_hull",
        "ifc_placement_bbox",
        "unavailable",
    ] = "unavailable"


class DoorPortal(BaseModel):
    """Point (or short segment) where a path may cross a door opening."""

    global_id: str
    name: str = ""
    storey_global_id: str | None = None
    point: Point2D | None = None
    """Long axis of the leaf in plan (two endpoints), when known."""
    segment: list[Point2D] = Field(default_factory=list)
    """Plan hull of the door (thin rectangle). Empty when unmeasured."""
    polygon: list[Point2D] = Field(default_factory=list)
    """Unit XY vector through the wall (door facing). Used for ± ray heal."""
    normal: Point2D | None = None
    incomplete: bool = False
    method: Literal[
        "ifc_mesh_xy_centroid",
        "ifc_object_placement",
        "unavailable",
    ] = "unavailable"


class OpeningPortal(BaseModel):
    """2D portal for an IfcOpeningElement (void in a wall / open-plan gap)."""

    global_id: str
    name: str = ""
    storey_global_id: str | None = None
    point: Point2D | None = None
    segment: list[Point2D] = Field(default_factory=list)
    incomplete: bool = False
    method: Literal[
        "ifc_mesh_xy_centroid",
        "ifc_object_placement",
        "unavailable",
    ] = "unavailable"
    """Door that fills this opening via IfcRelFillsElement, if any."""
    filled_by_door_global_id: str | None = None
    """Window that fills this opening, if any (not treated as walkable in v1)."""
    filled_by_window_global_id: str | None = None
    """Element this opening voids via IfcRelVoidsElement, if any."""
    host_global_id: str | None = None
    """True when the voided element is an IfcWall. Revit exports furniture
    recesses (cabinets, counters) as openings too; those void the furniture."""
    host_is_wall: bool = False
    """Plan hull of the void (XY metres). Empty when unmeasured — a doorway is
    long and thin, a wall-profile void is large in both directions."""
    polygon: list[Point2D] = Field(default_factory=list)
    """Lowest / highest Z of the void (metres). None when unmeasured. Used to
    reject duct holes, hatches and window bands that nobody can walk through."""
    sill_z: float | None = None
    head_z: float | None = None


class StairFootprint(BaseModel):
    """2D plan outline for an IfcStair (top-down hull), for floorplan overlay."""

    global_id: str
    name: str = ""
    storey_global_id: str | None = None
    polygon: list[Point2D] = Field(default_factory=list)
    incomplete: bool = False
    method: Literal[
        "ifc_mesh_xy_hull",
        "ifc_placement_bbox",
        "unavailable",
    ] = "unavailable"


class WallFootprint(BaseModel):
    """2D plan outline for an IfcWall (top-down hull), for space↔space strip tests."""

    global_id: str
    name: str = ""
    storey_global_id: str | None = None
    polygon: list[Point2D] = Field(default_factory=list)
    incomplete: bool = False
    method: Literal[
        "ifc_mesh_xy_hull",
        "ifc_placement_bbox",
        "unavailable",
    ] = "unavailable"


class FootprintsDocument(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    model_id: str
    built_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    coordinate_system: Literal["ifc_world_xy_metres"] = "ifc_world_xy_metres"
    storeys: list[StoreyFootprintMeta] = Field(default_factory=list)
    spaces: list[SpaceFootprint] = Field(default_factory=list)
    doors: list[DoorPortal] = Field(default_factory=list)
    openings: list[OpeningPortal] = Field(default_factory=list)
    stairs: list[StairFootprint] = Field(default_factory=list)
    walls: list[WallFootprint] = Field(default_factory=list)
