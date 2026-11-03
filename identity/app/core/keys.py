"""Clave de firma de parámetros de identidad.

* Clave Ed25519 que firma los parámetros públicos de cada elección.

Las claves RSA de firma ciega de tokens ya NO están aquí: las custodia el servicio
Blind Signature (una por elección). La clave privada vive solo en este volumen.
"""

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

PARAMETER_KEY_FILE = "parameter_signing.pem"


@dataclass(frozen=True)
class IdentityKeys:
    parameter_private: ed25519.Ed25519PrivateKey
    parameter_key_id: str

    @property
    def parameter_public_raw(self) -> bytes:
        return self.parameter_private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )


def _key_id(public_bytes: bytes) -> str:
    # 16 hex = 64 bits del SHA-256; cabe en el límite de 64 bytes de `kid`.
    return hashlib.sha256(public_bytes).hexdigest()[:16]


def _write_private(path: Path, key) -> None:
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(pem)


def load_keys(keys_dir: Path) -> IdentityKeys:
    keys_dir.mkdir(parents=True, exist_ok=True)
    path = keys_dir / PARAMETER_KEY_FILE
    if path.exists():
        parameter_private = serialization.load_pem_private_key(path.read_bytes(), password=None)
    else:
        parameter_private = ed25519.Ed25519PrivateKey.generate()
        _write_private(path, parameter_private)
    if not isinstance(parameter_private, ed25519.Ed25519PrivateKey):
        raise ValueError("parameter signing key must be Ed25519")

    public_raw = parameter_private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return IdentityKeys(parameter_private=parameter_private, parameter_key_id=_key_id(public_raw))
