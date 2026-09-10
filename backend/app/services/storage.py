from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import UploadFile

from app.config import Settings
from app.schemas.entities import EntitiesExtract, ModelMetadata
from app.schemas.graph import ConnectivityGraph
from app.schemas.footprints import FootprintsDocument

ALLOWED_EXTENSIONS = {".ifc", ".ifczip"}


class ModelNotFoundError(Exception):
    pass


class InvalidIfcUploadError(Exception):
    pass


def _models_root(settings: Settings) -> Path:
    return settings.data_path / "models"


def _derived_root(settings: Settings) -> Path:
    return settings.data_path / "derived"


def model_dir(settings: Settings, model_id: str) -> Path:
    return _models_root(settings) / model_id


def ifc_path(settings: Settings, model_id: str) -> Path:
    return model_dir(settings, model_id) / "model.ifc"


def meta_path(settings: Settings, model_id: str) -> Path:
    return model_dir(settings, model_id) / "meta.json"


def entities_path(settings: Settings, model_id: str) -> Path:
    return _derived_root(settings) / model_id / "entities.json"


def graph_path(settings: Settings, model_id: str, variant: str = "ifc") -> Path:
    """IFC baseline stays at graph.json; other variants use graph.<variant>.json."""
    if variant == "ifc":
        return _derived_root(settings) / model_id / "graph.json"
    return _derived_root(settings) / model_id / f"graph.{variant}.json"


def footprints_path(settings: Settings, model_id: str) -> Path:
    return _derived_root(settings) / model_id / "footprints.json"


def _write_meta(path: Path, meta: ModelMetadata) -> None:
    path.write_text(meta.model_dump_json(indent=2), encoding="utf-8")


def read_meta(settings: Settings, model_id: str) -> ModelMetadata:
    path = meta_path(settings, model_id)
    if not path.is_file():
        raise ModelNotFoundError(model_id)
    return ModelMetadata.model_validate_json(path.read_text(encoding="utf-8"))


async def save_upload(settings: Settings, upload: UploadFile) -> ModelMetadata:
    filename = upload.filename or "upload.ifc"
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise InvalidIfcUploadError(
            f"Unsupported file type '{suffix}'. Allowed: {sorted(ALLOWED_EXTENSIONS)}"
        )

    model_id = str(uuid.uuid4())
    directory = model_dir(settings, model_id)
    directory.mkdir(parents=True, exist_ok=False)

    destination = ifc_path(settings, model_id)
    size = 0
    with destination.open("wb") as out:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            out.write(chunk)

    meta = ModelMetadata(
        model_id=model_id,
        original_filename=Path(filename).name,
        size_bytes=size,
        created_at=datetime.now(timezone.utc),
        extract_status="none",
    )
    _write_meta(meta_path(settings, model_id), meta)
    return meta


def update_extract_status(
    settings: Settings, model_id: str, status: str
) -> ModelMetadata:
    meta = read_meta(settings, model_id)
    meta.extract_status = status  # type: ignore[assignment]
    _write_meta(meta_path(settings, model_id), meta)
    return meta


def save_entities(settings: Settings, extract: EntitiesExtract) -> Path:
    path = entities_path(settings, extract.model_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(extract.model_dump_json(indent=2), encoding="utf-8")
    return path


def read_entities(settings: Settings, model_id: str) -> EntitiesExtract:
    path = entities_path(settings, model_id)
    if not path.is_file():
        raise ModelNotFoundError(f"entities for {model_id}")
    return EntitiesExtract.model_validate_json(path.read_text(encoding="utf-8"))


def save_graph(
    settings: Settings, graph: ConnectivityGraph, variant: str | None = None
) -> Path:
    v = variant or getattr(graph, "variant", None) or "ifc"
    path = graph_path(settings, graph.model_id, v)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(graph.model_dump_json(indent=2), encoding="utf-8")
    return path


def read_graph(
    settings: Settings, model_id: str, variant: str = "ifc"
) -> ConnectivityGraph:
    path = graph_path(settings, model_id, variant)
    if not path.is_file():
        raise ModelNotFoundError(f"graph ({variant}) for {model_id}")
    graph = ConnectivityGraph.model_validate_json(path.read_text(encoding="utf-8"))
    # Older graph.json files lack variant — treat as ifc.
    if variant == "ifc" and graph.variant != "ifc":
        graph = graph.model_copy(update={"variant": "ifc"})
    return graph


def save_footprints(settings: Settings, doc: FootprintsDocument) -> Path:
    path = footprints_path(settings, doc.model_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(doc.model_dump_json(indent=2), encoding="utf-8")
    return path


def read_footprints(settings: Settings, model_id: str) -> FootprintsDocument:
    path = footprints_path(settings, model_id)
    if not path.is_file():
        raise ModelNotFoundError(f"footprints for {model_id}")
    return FootprintsDocument.model_validate_json(path.read_text(encoding="utf-8"))
