"""Claves RSA de firma ciega, una por elección.

La clave privada nunca sale de este servicio. Se crea la primera vez que se pide
la clave pública (Identity lo hace al abrir la urna) y se reutiliza después.
Una clave por elección limita el daño si una se filtra.
"""

import hashlib
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app import blind_rsa

RSA_BITS = 2048  # Mínimo exigido por `ballot`.
# Evita path traversal: el id forma parte del nombre del archivo.
ELECTION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class InvalidElectionId(ValueError):
    pass


@dataclass(frozen=True)
class ElectionKey:
    private: rsa.RSAPrivateKey
    kid: str

    @property
    def public_der(self) -> bytes:
        return blind_rsa.public_key_der(self.private.public_key())


class KeyStore:
    def __init__(self, keys_dir: Path):
        self._dir = keys_dir
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def get_or_create(self, election_id: str) -> ElectionKey:
        if not ELECTION_ID.match(election_id):
            raise InvalidElectionId("election_id must match [A-Za-z0-9_-]{1,128}")
        path = self._dir / f"election-{election_id}.pem"
        with self._lock:
            if path.exists():
                key = serialization.load_pem_private_key(path.read_bytes(), password=None)
            else:
                key = rsa.generate_private_key(public_exponent=65537, key_size=RSA_BITS)
                self._write(path, key)
        if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < RSA_BITS:
            raise ValueError("election key must be RSA with at least 2048 bits")
        der = blind_rsa.public_key_der(key.public_key())
        # 16 hex = 64 bits del SHA-256 del SPKI; cabe en el límite de 64 bytes de `kid`.
        return ElectionKey(private=key, kid=hashlib.sha256(der).hexdigest()[:16])

    @staticmethod
    def _write(path: Path, key: rsa.RSAPrivateKey) -> None:
        pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(pem)
