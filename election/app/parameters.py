"""Parámetros públicos de una elección y su firma.

Los bytes firmados son un JSON canónico (claves ordenadas, sin espacios, ASCII) y
la firma es Ed25519 sobre ``DOMAIN || bytes_canónicos``. El cliente verifica estos
bytes exactos con la llave de ``GET /keys`` antes de cifrar el voto.

La llave del token anónimo no forma parte de estos parámetros: la publica
Identity/Blind Signature, que es quien la custodia.
"""

import json
from datetime import datetime

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ed25519

from app.encoding import b64url_encode

DOMAIN = b"votaciones.election.parameters.v1\x00"
VERSION = 1


def canonical_parameters(
    *,
    election_id: str,
    name: str,
    options: list[str],
    blank_option: str | None,
    opens_at: datetime,
    closes_at: datetime,
    encryption_algorithm: str,
    encryption_public_key: bytes,
) -> bytes:
    document = {
        "v": VERSION,
        "election_id": election_id,
        "name": name,
        "options": options,
        "blank_option": blank_option,
        "opens_at": int(opens_at.timestamp()),
        "closes_at": int(closes_at.timestamp()),
        "encryption": {
            "algorithm": encryption_algorithm,
            "public_key": b64url_encode(encryption_public_key),
        },
    }
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
        "ascii"
    )


def sign(private_key: ed25519.Ed25519PrivateKey, canonical: bytes) -> bytes:
    return private_key.sign(DOMAIN + canonical)


def verify(public_key: ed25519.Ed25519PublicKey, canonical: bytes, signature: bytes) -> bool:
    try:
        public_key.verify(signature, DOMAIN + canonical)
    except InvalidSignature:
        return False
    return True
