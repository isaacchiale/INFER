from __future__ import annotations

import ifcopenshell
import ifcopenshell.util.element

from app.schemas.entities import (
    DoorEntity,
    EntitiesExtract,
    ExitCandidateEntity,
    LiftEntity,
    SpaceEntity,
    StairEntity,
    StoreyEntity,
)
from app.services.ifc_units import length_to_metres

EXIT_MARKERS = ("exit", "evac", "fire escape", "emergency")


def _name_of(element) -> str:
    return (getattr(element, "Name", None) or getattr(element, "ObjectType", None) or "").strip()


def _global_id(element) -> str:
    return getattr(element, "GlobalId", None) or ""


def _storey_global_id(element) -> str | None:
    container = ifcopenshell.util.element.get_container(element)
    if container is None:
        return None
    if container.is_a("IfcBuildingStorey"):
        return _global_id(container)
    return None


def _exit_reason(name: str, object_type: str) -> str | None:
    haystack = f"{name} {object_type}".lower()
    for marker in EXIT_MARKERS:
        if marker in haystack:
            return f"name/object_type matched '{marker}'"
    return None


def extract_entities(model_id: str, ifc_file_path: str) -> EntitiesExtract:
    ifc = ifcopenshell.open(ifc_file_path)

    storeys: list[StoreyEntity] = []
    for storey in ifc.by_type("IfcBuildingStorey"):
        elevation = getattr(storey, "Elevation", None)
        storeys.append(
            StoreyEntity(
                global_id=_global_id(storey),
                name=_name_of(storey),
                elevation=length_to_metres(
                    ifc, float(elevation) if elevation is not None else None
                ),
            )
        )

    spaces: list[SpaceEntity] = []
    for space in ifc.by_type("IfcSpace"):
        spaces.append(
            SpaceEntity(
                global_id=_global_id(space),
                name=_name_of(space),
                storey_global_id=_storey_global_id(space),
            )
        )

    doors: list[DoorEntity] = []
    exit_candidates: list[ExitCandidateEntity] = []
    for door in ifc.by_type("IfcDoor"):
        name = _name_of(door)
        object_type = (getattr(door, "ObjectType", None) or "").strip()
        doors.append(
            DoorEntity(
                global_id=_global_id(door),
                name=name,
                storey_global_id=_storey_global_id(door),
            )
        )
        reason = _exit_reason(name, object_type)
        if reason:
            exit_candidates.append(
                ExitCandidateEntity(
                    global_id=_global_id(door),
                    name=name,
                    reason=reason,
                )
            )

    stairs = [
        StairEntity(global_id=_global_id(stair), name=_name_of(stair))
        for stair in ifc.by_type("IfcStair")
    ]

    lifts: list[LiftEntity] = []
    for element in ifc.by_type("IfcTransportElement"):
        name = _name_of(element)
        object_type = (getattr(element, "ObjectType", None) or "").strip().lower()
        predefined = str(getattr(element, "PredefinedType", "") or "").lower()
        if "elev" in object_type or "lift" in object_type or predefined == "elevator":
            lifts.append(LiftEntity(global_id=_global_id(element), name=name or "Lift"))
        else:
            # Include transport elements as lifts for POC navigation coverage
            lifts.append(LiftEntity(global_id=_global_id(element), name=name or element.is_a()))

    return EntitiesExtract(
        model_id=model_id,
        storeys=storeys,
        spaces=spaces,
        doors=doors,
        stairs=stairs,
        lifts=lifts,
        exit_candidates=exit_candidates,
    )
