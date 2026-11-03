"""Configuración del servicio de firma ciega (variables ``BLINDSIG_*``)."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BLINDSIG_", env_file=".env", extra="ignore")

    # Aquí viven las claves privadas RSA (una por elección). Montar como volumen.
    keys_dir: Path = Path("./keys")
    # OBLIGATORIO: secreto compartido con Identity (cabecera X-Internal-Token).
    # Es una protección adicional a la red interna; el servicio no arranca sin él.
    api_key: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
