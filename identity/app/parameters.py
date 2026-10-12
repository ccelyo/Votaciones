"""Parámetros públicos de una elección y su firma.

PROPUESTA pendiente de acuerdo con M1/M4 (ver proto/README.md): los bytes firmados
son un JSON canónico (claves ordenadas, sin espacios, ASCII) y la firma es Ed25519
sobre ``DOMAIN || bytes_canónicos``. El navegador verifica estos bytes exactos
antes de cifrar el voto; `ballot` los guarda sin interpretarlos en el Prototype 1.
"""

import json

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ed25519

from app.ballot_client import TokenKey
from app.encoding import b64url_encode

DOMAIN = b"votaciones.identity.election-parameters.v1\x00"
ALGORITHM = "Ed25519"
VERSION = 1


def canonical_parameters(
    *,
    election_id: str,
    options: list[str],
    encryption_public_key: bytes,
    opens_at: int,
    closes_at: int,
    token_key: TokenKey,
) -> bytes:
    document = {
        "v": VERSION,
        "election_id": election_id,
        "options": options,
        "encryption_public_key": b64url_encode(encryption_public_key),
        "opens_at": opens_at,
        "closes_at": closes_at,
        "token_key": {
            "kid": token_key.kid,
            "public_key_der": b64url_encode(token_key.public_key_der),
            "variant": token_key.signature_variant,
        },
    }
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
        "ascii"
    )


def sign_parameters(private_key: ed25519.Ed25519PrivateKey, canonical: bytes) -> bytes:
    return private_key.sign(DOMAIN + canonical)


def verify_parameters(
    public_key: ed25519.Ed25519PublicKey, canonical: bytes, signature: bytes
) -> bool:
    try:
        public_key.verify(signature, DOMAIN + canonical)
    except InvalidSignature:
        return False
    return True
