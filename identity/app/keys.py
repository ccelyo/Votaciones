"""Claves privadas de identidad.

* Clave RSA de firma ciega de tokens (la pública se registra en `ballot`).
* Clave Ed25519 que firma los parámetros públicos de cada elección.

Las claves privadas viven solo en este proceso/volumen y nunca se envían por red.
"""

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa

from app import blind_rsa

RSA_BITS = 2048  # Mínimo exigido por `ballot` (>= 2048 bits).
TOKEN_KEY_FILE = "token_signing.pem"
PARAMETER_KEY_FILE = "parameter_signing.pem"


@dataclass(frozen=True)
class IdentityKeys:
    token_private: rsa.RSAPrivateKey
    token_kid: str
    parameter_private: ed25519.Ed25519PrivateKey
    parameter_key_id: str

    @property
    def token_public_der(self) -> bytes:
        return blind_rsa.public_key_der(self.token_private.public_key())

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


def _load_or_create(path: Path, factory):
    if path.exists():
        return serialization.load_pem_private_key(path.read_bytes(), password=None)
    key = factory()
    _write_private(path, key)
    return key


def load_keys(keys_dir: Path) -> IdentityKeys:
    keys_dir.mkdir(parents=True, exist_ok=True)
    token_private = _load_or_create(
        keys_dir / TOKEN_KEY_FILE,
        lambda: rsa.generate_private_key(public_exponent=65537, key_size=RSA_BITS),
    )
    parameter_private = _load_or_create(
        keys_dir / PARAMETER_KEY_FILE, ed25519.Ed25519PrivateKey.generate
    )
    if not isinstance(token_private, rsa.RSAPrivateKey) or token_private.key_size < RSA_BITS:
        raise ValueError("token signing key must be RSA with at least 2048 bits")
    if not isinstance(parameter_private, ed25519.Ed25519PrivateKey):
        raise ValueError("parameter signing key must be Ed25519")

    parameter_public_raw = parameter_private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return IdentityKeys(
        token_private=token_private,
        token_kid=_key_id(blind_rsa.public_key_der(token_private.public_key())),
        parameter_private=parameter_private,
        parameter_key_id=_key_id(parameter_public_raw),
    )
