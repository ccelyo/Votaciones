"""Lado servidor de la firma ciega RSA (RFC 9474, RSABSSA).

Identidad solo ejecuta ``BlindSign`` (RFC 9474 sec. 4.2): firma el mensaje cegado
que envía el navegador sin ver el contenido del token. Cegar, descegar y la
codificación EMSA-PSS ocurren en el navegador (``Finalize``); Go verifica el
resultado con la variante registrada en ``TokenVerificationKey.signature_variant``.

Como la entrada ya viene cegada con un factor aleatorio del cliente, la operación
RSA con exponente privado no filtra información útil sobre el token.
"""

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

# Variante acordada con `ballot` (ver ballot/docs/qa/happy-path.md).
VARIANT = "RSABSSA-SHA384-PSS-Randomized"


class BlindSignError(ValueError):
    """El mensaje cegado no es válido para esta clave."""


def modulus_size(public_key: rsa.RSAPublicKey) -> int:
    return (public_key.key_size + 7) // 8


def public_key_der(public_key: rsa.RSAPublicKey) -> bytes:
    """Codificación DER SubjectPublicKeyInfo que espera `ballot`."""
    return public_key.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def blind_sign(private_key: rsa.RSAPrivateKey, blinded_msg: bytes) -> bytes:
    """RFC 9474 sec. 4.2: ``blind_sig = I2OSP(RSASP1(sk, OS2IP(blinded_msg)), k)``."""
    numbers = private_key.private_numbers()
    n = numbers.public_numbers.n
    e = numbers.public_numbers.e
    k = modulus_size(private_key.public_key())

    if len(blinded_msg) != k:
        raise BlindSignError("blinded message length must equal the modulus length")
    m = int.from_bytes(blinded_msg, "big")
    if m >= n:
        raise BlindSignError("blinded message representative out of range")

    s = pow(m, numbers.d, n)
    # Comprobación contra fallos de cálculo (RFC 9474 sec. 4.2): s^e mod n == m.
    if pow(s, e, n) != m:
        raise RuntimeError("blind signature self-check failed")
    return s.to_bytes(k, "big")
