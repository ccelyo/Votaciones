"""Configuración del servicio de identidad, leída de variables de entorno."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="IDENTITY_", env_file=".env", extra="ignore")

    # PostgreSQL (zona de identidad).
    database_url: str = "postgresql+psycopg://identity:identity@localhost:5432/identity"

    # Listener gRPC interno de `ballot` (zona de votación). Sin mTLS en el Prototype 1.
    ballot_grpc_addr: str = "127.0.0.1:9091"
    ballot_grpc_timeout_seconds: float = 5.0

    # Directorio de claves privadas de identidad (firma ciega y firma de parámetros).
    # Si no existen se crean con permisos 0600. En producción deben provenir de un
    # gestor de secretos montado como volumen.
    keys_dir: Path = Path("./keys")

    # Autenticación simulada SOLO para desarrollo: acepta las cabeceras X-Dev-User
    # y X-Dev-Roles. Debe reemplazarse por la sesión real de login + MFA (M5).
    dev_auth: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
