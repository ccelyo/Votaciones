"""Llaves del servicio Election (FA-09).

* **Llave de la urna** (una por elección): RSA, esquema híbrido
  ``RSA-OAEP-256+A256GCM`` que descifra Tally. La pública viaja en los parámetros
  y en ``election.created`` para que los clientes cifren el voto. La privada se
  cifra con AES-256-GCM bajo la llave maestra (KEK) antes de tocar la base de
  datos y solo se descifra para entregarla, cerrada la urna, a Tally.
* **Llave de parámetros**: Ed25519 propia del servicio; firma los parámetros
  públicos para que los clientes detecten manipulaciones del Gateway o de Ballot.
* **Llave maestra (KEK)**: 32 bytes de ``ELECTION_URN_KEK`` o de
  ``<keys_dir>/urn_kek.bin`` (se crea si no existe). En producción debe venir de
  un gestor de secretos y nunca del mismo volumen que la base de datos.
"""

import base64
import hashlib
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

URN_ALGORITHM = "RSA-OAEP-256+A256GCM"
PARAMETER_ALGORITHM = "Ed25519"
PARAMETER_KEY_FILE = "parameter_signing.pem"
KEK_FILE = "urn_kek.bin"
KEK_BYTES = 32
NONCE_BYTES = 12

# Liga cada llave privada cifrada a su elección: no se puede copiar el blob de
# una urna a otra fila sin que falle el descifrado.
_WRAP_DOMAIN = b"votaciones.election.urn-key.v1\x00"


@dataclass(frozen=True)
class GeneratedUrnKey:
    public_key_der: bytes
    wrapped_private_key: bytes
    wrap_nonce: bytes
    kek_id: str


@dataclass(frozen=True)
class ServiceKeys:
    parameter_private: ed25519.Ed25519PrivateKey
    parameter_key_id: str
    kek: bytes
    kek_id: str
    urn_key_bits: int

    @property
    def parameter_public_raw(self) -> bytes:
        return self.parameter_private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )

    # --- llaves de la urna ---------------------------------------------------

    def generate_urn_key(self, election_ref: str) -> GeneratedUrnKey:
        private = rsa.generate_private_key(public_exponent=65537, key_size=self.urn_key_bits)
        private_der = private.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        nonce = secrets.token_bytes(NONCE_BYTES)
        wrapped = AESGCM(self.kek).encrypt(nonce, private_der, _aad(election_ref))
        return GeneratedUrnKey(
            public_key_der=public_key_der(private.public_key()),
            wrapped_private_key=wrapped,
            wrap_nonce=nonce,
            kek_id=self.kek_id,
        )

    def unwrap_urn_key(self, election_ref: str, wrapped: bytes, nonce: bytes, kek_id: str) -> rsa.RSAPrivateKey:
        if kek_id != self.kek_id:
            raise ValueError("urn key was wrapped with a different master key")
        private_der = AESGCM(self.kek).decrypt(nonce, wrapped, _aad(election_ref))
        private = serialization.load_der_private_key(private_der, password=None)
        if not isinstance(private, rsa.RSAPrivateKey):
            raise ValueError("stored urn key is not RSA")
        return private


def _aad(election_ref: str) -> bytes:
    return _WRAP_DOMAIN + election_ref.encode("ascii")


def public_key_der(key: rsa.RSAPublicKey) -> bytes:
    """SubjectPublicKeyInfo DER (lo que importa WebCrypto con ``spki``)."""
    return key.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def private_key_pem(key: rsa.RSAPrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")


def key_id(material: bytes) -> str:
    return hashlib.sha256(material).hexdigest()[:16]


# --- carga -------------------------------------------------------------------


def _write_secret(path: Path, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)


def _load_parameter_key(path: Path) -> ed25519.Ed25519PrivateKey:
    if not path.exists():
        key = ed25519.Ed25519PrivateKey.generate()
        _write_secret(
            path,
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ),
        )
        return key
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, ed25519.Ed25519PrivateKey):
        raise ValueError("parameter signing key must be Ed25519")
    return key


def _decode_kek(raw: str) -> bytes:
    value = raw.strip()
    try:
        kek = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except ValueError as error:
        raise ValueError("ELECTION_URN_KEK must be base64url") from error
    if len(kek) != KEK_BYTES:
        raise ValueError(f"ELECTION_URN_KEK must decode to {KEK_BYTES} bytes")
    return kek


def _load_kek(configured: str, path: Path) -> bytes:
    if configured:
        return _decode_kek(configured)
    if not path.exists():
        _write_secret(path, secrets.token_bytes(KEK_BYTES))
    kek = path.read_bytes()
    if len(kek) != KEK_BYTES:
        raise ValueError(f"{path} must contain exactly {KEK_BYTES} bytes")
    return kek


def load_keys(keys_dir: Path, *, urn_kek: str = "", urn_key_bits: int = 3072) -> ServiceKeys:
    keys_dir.mkdir(parents=True, exist_ok=True)
    parameter_private = _load_parameter_key(keys_dir / PARAMETER_KEY_FILE)
    kek = _load_kek(urn_kek, keys_dir / KEK_FILE)
    parameter_public = parameter_private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return ServiceKeys(
        parameter_private=parameter_private,
        parameter_key_id=key_id(parameter_public),
        kek=kek,
        # Identifica la KEK sin revelarla (hash con dominio propio).
        kek_id=key_id(b"votaciones.election.kek-id\x00" + kek),
        urn_key_bits=urn_key_bits,
    )
