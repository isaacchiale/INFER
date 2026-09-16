from __future__ import annotations

import json
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import UploadFile

from app.config import Settings
from app.schemas.entities import EntitiesExtract, ModelMetadata
from app.schemas.graph import ConnectivityGraph
from app.schemas.footprints import FootprintsDocument

ALLOWED_EXTENSIONS = {".ifc", ".ifczip", ".gml", ".indoorgml"}
INDOORGML_EXTENSIONS = {".gml", ".indoorgml"}


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


def indoorgml_path(settings: Settings, model_id: str) -> Path:
    return model_dir(settings, model_id) / "model.indoorgml"


def source_path(settings: Settings, model_id: str, source_format: str) -> Path:
    """The stored source file for whichever format this model was uploaded
    as — every downstream service resolves its own input through this
    rather than assuming `ifc_path()`."""
    return (
        indoorgml_path(settings, model_id)
        if source_format == "indoorgml"
        else ifc_path(settings, model_id)
    )


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


async def _stream_upload(settings: Settings, upload: UploadFile, destination: Path) -> int:
    """Stream to disk in chunks (never buffers the whole file in memory),
    aborting once the configured size cap is exceeded rather than after
    writing an unbounded amount to disk."""
    size = 0
    with destination.open("wb") as out:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > settings.max_upload_bytes:
                raise InvalidIfcUploadError(
                    f"File exceeds the {settings.max_upload_mb} MB upload limit."
                )
            out.write(chunk)
    return size


async def _save_ifczip_upload(settings: Settings, upload: UploadFile, destination: Path) -> int:
    """Unzip at upload time so every downstream consumer (extract/footprints/
    graph builders) can keep calling ifcopenshell.open() on the fixed
    `model.ifc` path and get real STEP text — mirrors what
    ifcopenshell.open() does internally for a .ifcZIP path (extract the inner
    .ifc/.ifcXML to a temp dir and open that), just persisted at the model's
    well-known location instead of a throwaway temp dir that vanishes after
    that one open() call."""
    with tempfile.NamedTemporaryFile(suffix=".ifczip", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        await _stream_upload(settings, upload, tmp_path)
        try:
            with zipfile.ZipFile(tmp_path) as zf:
                inner = next(
                    (n for n in zf.namelist() if Path(n).suffix.lower() in (".ifc", ".ifcxml")),
                    None,
                )
                if inner is None:
                    raise InvalidIfcUploadError(
                        "No .ifc or .ifcXML file found inside the .ifczip archive."
                    )
                with zf.open(inner) as src, destination.open("wb") as out:
                    shutil.copyfileobj(src, out)
        except zipfile.BadZipFile as exc:
            raise InvalidIfcUploadError("Uploaded .ifczip is not a valid zip archive.") from exc
    finally:
        tmp_path.unlink(missing_ok=True)
    return destination.stat().st_size


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
    source_format = "indoorgml" if suffix in INDOORGML_EXTENSIONS else "ifc"

    try:
        destination = source_path(settings, model_id, source_format)
        if suffix == ".ifczip":
            size = await _save_ifczip_upload(settings, upload, destination)
        else:
            size = await _stream_upload(settings, upload, destination)
    except Exception:
        # Don't leave a half-written model directory behind on any failure
        # (size cap, bad zip, missing inner IFC) — the model_id was never
        # handed back to the caller, so nothing else could be pointing at it.
        shutil.rmtree(directory, ignore_errors=True)
        raise

    meta = ModelMetadata(
        model_id=model_id,
        original_filename=Path(filename).name,
        size_bytes=size,
        created_at=datetime.now(timezone.utc),
        extract_status="none",
        source_format=source_format,
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


def _route_shares_root(settings: Settings) -> Path:
    return settings.data_path / "route-shares"


ROUTE_SHARE_EXTENSIONS = {"glb", "usdz"}


def route_share_path(settings: Settings, share_id: str, ext: str = "glb") -> Path:
    if ext not in ROUTE_SHARE_EXTENSIONS:
        raise ValueError(f"Unsupported route share extension: {ext}")
    return _route_shares_root(settings) / f"{share_id}.{ext}"


# Router docstring calls this "ephemeral hosting" — without an actual sweep
# it was permanent hosting with an expiry date nobody enforced. No task
# queue or cron in this app, so the cheapest correct trigger is "whenever a
# new one is created" rather than a background job.
ROUTE_SHARE_MAX_AGE_DAYS = 7


def _sweep_expired_route_shares(settings: Settings) -> None:
    root = _route_shares_root(settings)
    if not root.is_dir():
        return
    cutoff = datetime.now(timezone.utc).timestamp() - ROUTE_SHARE_MAX_AGE_DAYS * 86400
    for ext in ROUTE_SHARE_EXTENSIONS:
        for file in root.glob(f"*.{ext}"):
            try:
                if file.stat().st_mtime < cutoff:
                    file.unlink(missing_ok=True)
            except OSError:
                # Best-effort — a share someone's actively viewing shouldn't
                # block or fail the upload that triggered this sweep.
                pass


def save_route_share(
    settings: Settings, data: bytes, ext: str = "glb", share_id: str | None = None
) -> str:
    """
    Store an exported route file under `share_id` (a fresh random id when
    omitted; pass one back in to attach a second format — e.g. a `.usdz`
    alongside a `.glb` — to an already-created share). Returns the id.
    """
    root = _route_shares_root(settings)
    root.mkdir(parents=True, exist_ok=True)
    _sweep_expired_route_shares(settings)
    if share_id is None:
        share_id = uuid.uuid4().hex
    route_share_path(settings, share_id, ext).write_bytes(data)
    return share_id
