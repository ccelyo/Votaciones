"""Configuración del servicio Election, leída de variables de entorno (prefijo ELECTION_)."""

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from typing import Annotated


def normalize_database_url(url: str) -> str:
    """Acepta ``postgresql://`` y ``postgres://`` y usa el driver psycopg 3."""
    for legacy in ("postgresql://", "postgres://"):
        if url.startswith(legacy):
            return "postgresql+psycopg://" + url[len(legacy) :]
    return url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ELECTION_",
        env_file=".env",
        extra="ignore",
        populate_by_name=True,
    )

    # PostgreSQL «Elections». Se acepta ELECTION_DATABASE_URL o DATABASE_URL.
    database_url: str = Field(
        default="postgresql+psycopg://elections:elections@localhost:5433/elections",
        validation_alias=AliasChoices("ELECTION_DATABASE_URL", "DATABASE_URL", "database_url"),
    )
    # schema.sql es la fuente de verdad; solo para desarrollo sin init de PostgreSQL.
    auto_create_tables: bool = False

    # RabbitMQ. Vacío desactiva la publicación: los eventos quedan en el outbox.
    rabbitmq_uri: str = "amqp://guest:guest@localhost:5672/%2f"
    exchange: str = "election.events"
    # Cada cuánto revisa el publicador el outbox y las urnas vencidas.
    relay_interval_seconds: float = 1.0
    relay_batch_size: int = 100
    # Cierra automáticamente las urnas cuya ventana terminó (publica election.closed).
    auto_close: bool = True

    # Autenticación: JWT HS256 emitido por Auth (mismo secreto que el Gateway).
    jwt_secret: str = ""
    jwt_issuer: str = ""
    jwt_audience: str = ""
    # SOLO DESARROLLO: acepta X-Dev-User / X-Dev-Roles sin token.
    dev_auth: bool = False

    # Llave Ed25519 que firma los parámetros públicos (se crea si no existe).
    keys_dir: Path = Path("./keys")
    # Llave maestra (32 bytes, base64url) que cifra las llaves privadas de las urnas.
    # Si está vacía se lee/crea ``<keys_dir>/urn_kek.bin``.
    urn_kek: str = ""
    urn_key_bits: int = 3072

    allowed_origins: Annotated[list[str], NoDecode] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def _split_origins(cls, value):
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("database_url")
    @classmethod
    def _normalize(cls, value: str) -> str:
        return normalize_database_url(value)

    @field_validator("urn_key_bits")
    @classmethod
    def _key_bits(cls, value: int) -> int:
        if value < 2048:
            raise ValueError("urn keys need at least 2048 bits")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
