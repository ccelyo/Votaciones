"""Configuración del servicio de identidad, leída de variables de entorno."""

from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def normalize_database_url(url: str) -> str:
    """Acepta ``postgresql://`` y ``postgres://`` y usa el driver psycopg 3."""
    for legacy in ("postgresql://", "postgres://"):
        if url.startswith(legacy):
            return "postgresql+psycopg://" + url[len(legacy) :]
    return url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="IDENTITY_",
        env_file=".env",
        extra="ignore",
        populate_by_name=True,
    )

    # PostgreSQL de la zona de identidad.
    # Se acepta DATABASE_URL o IDENTITY_DATABASE_URL.
    database_url: str = Field(
        default="postgresql+psycopg://user:password@localhost:5432/votaciones",
        validation_alias=AliasChoices(
            "IDENTITY_DATABASE_URL",
            "DATABASE_URL",
            "database_url",
        ),
    )

    # Census: base PostgreSQL del padrón (vista C&C: Identity -> SQL -> Census).
    # Si se omite se usa la misma base que Auth (útil en desarrollo).
    census_database_url: str = Field(
        default="",
        validation_alias=AliasChoices("IDENTITY_CENSUS_DATABASE_URL", "CENSUS_DATABASE_URL"),
    )

    # Servicio Blind Signature (REST interno, solo accesible desde Identity).
    blind_signature_url: str = "http://127.0.0.1:8100"
    blind_signature_timeout_seconds: float = 5.0
    blind_signature_api_key: str = ""

    # Internal HTTPS listener; when required, callers must present a trusted
    # client certificate.
    tls_required: bool = False
    tls_cert_file: Path | None = None
    tls_key_file: Path | None = None
    tls_client_ca_file: Path | None = None

    # schema.sql es la fuente de verdad del esquema.
    # Por defecto la aplicación no crea las tablas al iniciar.
    auto_create_tables: bool = False

    # Listener gRPC interno de ballot, en la zona de votación.
    # Canal gRPC interno de Identity a Ballot.
    ballot_grpc_addr: str = "127.0.0.1:9091"
    ballot_grpc_timeout_seconds: float = 5.0
    ballot_grpc_tls: bool = False
    ballot_grpc_ca_file: Path | None = None
    ballot_grpc_cert_file: Path | None = None
    ballot_grpc_key_file: Path | None = None

    # Directorio donde identidad almacena sus claves privadas.
    # En producción deberían provenir de un gestor de secretos.
    keys_dir: Path = Path("./keys")

    # Orígenes CORS del frontend, separados por coma en IDENTITY_ALLOWED_ORIGINS.
    allowed_origins: Annotated[list[str], NoDecode] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    # Autenticación simulada SOLO para desarrollo y pruebas.
    # Permite X-Dev-User y X-Dev-Roles cuando se activa explícitamente.
    # La autenticación normal usa login + MFA + sesión Bearer.
    dev_auth: bool = False

    # MFA simplificado para Prototype 1.
    # El código de demostración puede sobrescribirse con IDENTITY_MFA_CODE.
    mfa_code: str = "123456"

    # Tiempo de vida del challenge MFA, en segundos.
    mfa_challenge_ttl_seconds: int = 300

    # Duración de la sesión autenticada, en segundos. Es también el ``exp`` del JWT.
    session_ttl_seconds: int = 3600

    # Claims ``iss`` y ``aud`` del JWT; el Gateway debe validar los mismos valores.
    jwt_issuer: str = "votaciones-identity"
    jwt_audience: str = "votaciones"

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def _split_origins(cls, value):
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("database_url", "census_database_url")
    @classmethod
    def _normalize(cls, value: str) -> str:
        return normalize_database_url(value) if value else value

    @model_validator(mode="after")
    def _validate_tls(self):
        if self.tls_required and not all((self.tls_cert_file, self.tls_key_file, self.tls_client_ca_file)):
            raise ValueError("IDENTITY_TLS_REQUIRED needs TLS_CERT_FILE, TLS_KEY_FILE and TLS_CLIENT_CA_FILE")
        if self.ballot_grpc_tls and not all(
            (self.ballot_grpc_ca_file, self.ballot_grpc_cert_file, self.ballot_grpc_key_file)
        ):
            raise ValueError(
                "IDENTITY_BALLOT_GRPC_TLS needs BALLOT_GRPC_CA_FILE, BALLOT_GRPC_CERT_FILE and BALLOT_GRPC_KEY_FILE"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()