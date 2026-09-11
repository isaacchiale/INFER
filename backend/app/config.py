from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(REPO_ROOT / "backend" / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "INFER API"
    host: str = "127.0.0.1"
    port: int = 8000
    # Comma-separated origins for the external frontend (local dev defaults).
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000"
    data_dir: str = str(REPO_ROOT / "data")
    # Generous cap for a single-building IFC — guards against an accidental
    # huge upload exhausting disk, not a tight production-grade limit.
    max_upload_mb: int = 500

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def data_path(self) -> Path:
        return Path(self.data_dir).expanduser().resolve()


@lru_cache
def get_settings() -> Settings:
    return Settings()
