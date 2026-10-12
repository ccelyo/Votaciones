"""Configuración del servicio de identidad, leída de variables de entorno."""

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def normalize_database_url(url: str) -> str:
    """Acepta ``postgresql://`` (formato de `.env.example`) y elige el driver psycopg 3."""
    for legacy in ("postgresql://", "postgres://"):
        if url.startswith(legacy):
            return "postgresql+psycopg://" + url[len(legacy) :]
    return url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="IDENTITY_", env_file=".env", extra="ignore", populate_by_name=True
    )

    # PostgreSQL (zona de identidad). Se acepta `DATABASE_URL` (como en .env.example)
    # o `IDENTITY_DATABASE_URL`.
    database_url: str = Field(
        default="postgresql+psycopg://user:password@localhost:5432/votaciones",
        validation_alias=AliasChoices("IDENTITY_DATABASE_URL", "DATABASE_URL", "database_url"),
    )

    # Crear las tablas al arrancar. `schema.sql` es la fuente de verdad del esquema
    # (se carga al iniciar PostgreSQL), así que por defecto NO se crean aquí.
    auto_create_tables: bool = False

    # Listener gRPC interno de `ballot` (zona de votación). Sin mTLS en el Prototype 1.
    ballot_grpc_addr: str = "127.0.0.1:9091"
    ballot_grpc_timeout_seconds: float = 5.0

    # Directorio de claves privadas de identidad (firma ciega y firma de parámetros).
    # Si no existen se crean con permisos 0600. En producción deben provenir de un
    # gestor de secretos montado como volumen.
    keys_dir: Path = Path("./keys")

    # Autenticación simulada SOLO para desarrollo: acepta las cabeceras X-Dev-User
    # (id numérico de `users`) y X-Dev-Roles. Debe reemplazarse por la sesión real
    # de login + MFA (M5).
    dev_auth: bool = False

    @field_validator("database_url")
    @classmethod
    def _normalize(cls, value: str) -> str:
        return normalize_database_url(value)


@lru_cache
def get_settings() -> Settings:
    return Settings()
