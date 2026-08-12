from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


class ModelMetadata(BaseModel):
    model_id: str
    original_filename: str
    size_bytes: int
    created_at: datetime
    extract_status: Literal["none", "ready", "failed"] = "none"


class EntityBase(BaseModel):
    global_id: str
    name: str = ""


class StoreyEntity(EntityBase):
    elevation: float | None = None


class SpaceEntity(EntityBase):
    storey_global_id: str | None = None


class DoorEntity(EntityBase):
    storey_global_id: str | None = None


class StairEntity(EntityBase):
    pass


class LiftEntity(EntityBase):
    pass


class ExitCandidateEntity(EntityBase):
    reason: str


class EntitiesExtract(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    model_id: str
    extracted_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    storeys: list[StoreyEntity] = Field(default_factory=list)
    spaces: list[SpaceEntity] = Field(default_factory=list)
    doors: list[DoorEntity] = Field(default_factory=list)
    stairs: list[StairEntity] = Field(default_factory=list)
    lifts: list[LiftEntity] = Field(default_factory=list)
    exit_candidates: list[ExitCandidateEntity] = Field(default_factory=list)
