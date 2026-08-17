"""IFC project-unit helpers. Geometry via ifcopenshell.geom is metres; raw attributes often are not."""

from __future__ import annotations

import ifcopenshell
import ifcopenshell.util.unit


def length_to_metres(ifc: ifcopenshell.file, value: float | None) -> float | None:
    """Convert a project-length attribute (e.g. IfcBuildingStorey.Elevation) to metres."""
    if value is None:
        return None
    scale = ifcopenshell.util.unit.calculate_unit_scale(ifc)
    return float(value) * float(scale)
