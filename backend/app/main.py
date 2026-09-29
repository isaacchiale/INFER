import asyncio
import contextlib
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings, get_settings
from app.routers import models, route_shares, routing
from app.services import storage

# Independent of the upload-triggered sweep in storage.save_route_share — a
# share should still expire on schedule even if nobody uploads a new one to
# trigger that path, or the "ephemeral" hosting the router promises becomes
# indefinite in practice.
ROUTE_SHARE_SWEEP_INTERVAL_SECONDS = 6 * 60 * 60


async def _sweep_route_shares_periodically(settings: Settings) -> None:
    while True:
        await asyncio.sleep(ROUTE_SHARE_SWEEP_INTERVAL_SECONDS)
        try:
            storage.sweep_expired_route_shares(settings)
        except OSError:
            # Best-effort background task — a transient FS error shouldn't kill the loop.
            pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    settings.data_path.mkdir(parents=True, exist_ok=True)
    (settings.data_path / "models").mkdir(parents=True, exist_ok=True)
    (settings.data_path / "derived").mkdir(parents=True, exist_ok=True)
    (settings.data_path / "route-shares").mkdir(parents=True, exist_ok=True)
    sweep_task = asyncio.create_task(_sweep_route_shares_periodically(settings))
    try:
        yield
    finally:
        sweep_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweep_task


def create_app() -> FastAPI:
    settings = get_settings()
    application = FastAPI(title=settings.app_name, lifespan=lifespan)

    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.get("/health")
    def health() -> dict[str, str]:
        return {
            "status": "ok",
            "service": settings.app_name,
        }

    application.include_router(models.router)
    application.include_router(routing.router)
    application.include_router(route_shares.router)
    return application


app = create_app()
