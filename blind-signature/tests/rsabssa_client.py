"""Cliente RSABSSA-SHA384-PSS-Randomized (RFC 9474) SOLO para pruebas.

En el sistema real, cegar y descegar ocurre en el navegador (M4). Esta
implementación simula al navegador para probar el servidor de identidad.
"""

import hashlib
import math
import secrets

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

HASH = hashlib.sha384
H_LEN = 48
SALT_LEN = 48
PREFIX_LEN = 32
TOKEN_DOMAIN = b"votaciones.ballot.anonymous-token.v1\x00"


def mgf1(seed: bytes, length: int) -> bytes:
    output = b""
    for counter in range(math.ceil(length / H_LEN)):
        output += HASH(seed + counter.to_bytes(4, "big")).digest()
    return output[:length]


def emsa_pss_encode(message: bytes, em_bits: int, salt: bytes) -> bytes:
    em_len = math.ceil(em_bits / 8)
    m_hash = HASH(message).digest()
    h = HASH(b"\x00" * 8 + m_hash + salt).digest()
    db = b"\x00" * (em_len - len(salt) - H_LEN - 2) + b"\x01" + salt
    masked = bytes(a ^ b for a, b in zip(db, mgf1(h, em_len - H_LEN - 1)))
    clear_bits = 8 * em_len - em_bits
    masked = bytes([masked[0] & (0xFF >> clear_bits)]) + masked[1:]
    return masked + h + b"\xbc"


def blind(
    public_key: rsa.RSAPublicKey,
    prepared_message: bytes,
    *,
    salt: bytes | None = None,
    r: int | None = None,
) -> tuple[bytes, int]:
    """Devuelve ``(blinded_msg, inv)``; ``prepared_message`` = prefijo(32) || mensaje."""
    numbers = public_key.public_numbers()
    n, e = numbers.n, numbers.e
    k = (n.bit_length() + 7) // 8
    salt = salt if salt is not None else secrets.token_bytes(SALT_LEN)
    encoded = emsa_pss_encode(prepared_message, n.bit_length() - 1, salt)
    m = int.from_bytes(encoded, "big")
    while r is None or math.gcd(r, n) != 1:
        r = secrets.randbelow(n - 2) + 2
    z = (m * pow(r, e, n)) % n
    return z.to_bytes(k, "big"), pow(r, -1, n)


def finalize(
    public_key: rsa.RSAPublicKey,
    prepared_message: bytes,
    blind_sig: bytes,
    inv: int,
    *,
    salt_len: int = SALT_LEN,
) -> bytes:
    n = public_key.public_numbers().n
    k = (n.bit_length() + 7) // 8
    signature = ((int.from_bytes(blind_sig, "big") * inv) % n).to_bytes(k, "big")
    verify(public_key, prepared_message, signature, salt_len=salt_len)
    return signature


def verify(
    public_key: rsa.RSAPublicKey,
    prepared_message: bytes,
    signature: bytes,
    *,
    salt_len: int = SALT_LEN,
) -> None:
    """Lanza InvalidSignature si no coincide (misma verificación que hace `ballot`)."""
    public_key.verify(
        signature,
        prepared_message,
        padding.PSS(mgf=padding.MGF1(hashes.SHA384()), salt_length=salt_len),
        hashes.SHA384(),
    )


def canonical_token_message(election_id: str, nonce: bytes) -> bytes:
    """Mensaje que el navegador ciega (ballot/internal/token.CanonicalTokenMessage)."""
    identifier = election_id.encode()
    return TOKEN_DOMAIN + len(identifier).to_bytes(2, "big") + identifier + nonce


def new_prepared_token_message(election_id: str) -> tuple[bytes, bytes]:
    """Devuelve ``(nonce, prepared_message)``."""
    nonce = secrets.token_bytes(32)
    prefix = secrets.token_bytes(PREFIX_LEN)
    return nonce, prefix + canonical_token_message(election_id, nonce)
