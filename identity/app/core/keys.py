"""Claves privadas de identidad.

* Clave Ed25519 que firma los parámetros públicos de cada elección.
* Clave RSA que firma los JWT de acceso.

Las claves RSA de firma ciega de tokens ya NO están aquí: las custodia el servicio
Blind Signature (una por elección). Las claves privadas viven solo en este volumen
y nunca se envían por red.
"""

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa

RSA_BITS = 2048
PARAMETER_KEY_FILE = "parameter_signing.pem"
JWT_KEY_FILE = "jwt_signing.pem"


@dataclass(frozen=True)
class IdentityKeys:
    parameter_private: ed25519.Ed25519PrivateKey
    parameter_key_id: str
    jwt_private: rsa.RSAPrivateKey
    jwt_kid: str

    @property
    def parameter_public_raw(self) -> bytes:
        return self.parameter_private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )


def _key_id(public_bytes: bytes) -> str:
    # 16 hex = 64 bits del SHA-256; cabe en el límite de 64 bytes de `kid`.
    return hashlib.sha256(public_bytes).hexdigest()[:16]


def _rsa_public_der(key: rsa.RSAPrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


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
    parameter_private = _load_or_create(
        keys_dir / PARAMETER_KEY_FILE, ed25519.Ed25519PrivateKey.generate
    )
    jwt_private = _load_or_create(
        keys_dir / JWT_KEY_FILE,
        lambda: rsa.generate_private_key(public_exponent=65537, key_size=RSA_BITS),
    )
    if not isinstance(parameter_private, ed25519.Ed25519PrivateKey):
        raise ValueError("parameter signing key must be Ed25519")
    if not isinstance(jwt_private, rsa.RSAPrivateKey) or jwt_private.key_size < RSA_BITS:
        raise ValueError("JWT signing key must be RSA with at least 2048 bits")

    public_raw = parameter_private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return IdentityKeys(
        parameter_private=parameter_private,
        parameter_key_id=_key_id(public_raw),
        jwt_private=jwt_private,
        jwt_kid=_key_id(_rsa_public_der(jwt_private)),
    )
