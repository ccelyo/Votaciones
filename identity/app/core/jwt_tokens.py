"""JWT de acceso (RS256) que emite identidad y valida el Gateway.

Formato acordado con el Gateway (Cristhian):

* Cabecera: ``alg=RS256``, ``typ=JWT``, ``kid`` = id de la clave en el JWKS.
* Claims: ``iss``, ``aud``, ``sub`` (``users.id`` en texto), ``username``, ``role``
  (``admin`` | ``voter``), ``iat``, ``nbf``, ``exp`` y ``jti``.
* Clave pública: ``GET /.well-known/jwks.json``. El Gateway valida firma, ``iss``,
  ``aud`` y ``exp`` sin compartir secretos; la rotación se hace por ``kid``.

La clave RSA del JWT es distinta de la de firma ciega: esa firma lo que el votante
le envía, así que con la misma clave se podría forjar un JWT.

``jti`` enlaza el JWT con la fila de ``sessions`` (se guarda su SHA-256), de modo que
identidad puede revocarlo en ``/logout``. El Gateway, sin estado, lo acepta hasta ``exp``.
"""

import secrets
from dataclasses import dataclass

import jwt

from app.core.encoding import b64url_encode
from app.core.errors import Unauthenticated
from app.core.keys import IdentityKeys

ALGORITHM = "RS256"
REQUIRED_CLAIMS = ["iss", "aud", "sub", "role", "iat", "nbf", "exp", "jti"]
LEEWAY_SECONDS = 30


@dataclass(frozen=True)
class AccessClaims:
    user_id: int
    role: str
    jti: str


def new_jti() -> str:
    return secrets.token_urlsafe(32)


def issue_access_token(
    keys: IdentityKeys,
    *,
    user_id: int,
    username: str,
    role: str,
    jti: str,
    issued_at: int,
    ttl_seconds: int,
    issuer: str,
    audience: str,
) -> str:
    claims = {
        "iss": issuer,
        "aud": audience,
        "sub": str(user_id),
        "username": username,
        "role": role,
        "iat": issued_at,
        "nbf": issued_at,
        "exp": issued_at + ttl_seconds,
        "jti": jti,
    }
    return jwt.encode(
        claims,
        keys.jwt_private,
        algorithm=ALGORITHM,
        headers={"kid": keys.jwt_kid, "typ": "JWT"},
    )


def decode_access_token(
    keys: IdentityKeys, token: str, *, issuer: str, audience: str
) -> AccessClaims:
    """Verifica firma, ``iss``, ``aud``, ``nbf`` y ``exp``; solo acepta RS256."""
    try:
        header = jwt.get_unverified_header(token)
        if header.get("kid") != keys.jwt_kid:
            raise jwt.InvalidTokenError("unknown kid")
        claims = jwt.decode(
            token,
            keys.jwt_private.public_key(),
            algorithms=[ALGORITHM],
            issuer=issuer,
            audience=audience,
            leeway=LEEWAY_SECONDS,
            options={"require": REQUIRED_CLAIMS},
        )
        sub = claims["sub"]
        if not isinstance(sub, str) or not sub.isascii() or not sub.isdigit():
            raise jwt.InvalidTokenError("invalid sub")
        return AccessClaims(user_id=int(sub), role=str(claims["role"]), jti=str(claims["jti"]))
    except jwt.PyJWTError as error:
        raise Unauthenticated("invalid or expired session") from error


def _uint_b64url(value: int) -> str:
    return b64url_encode(value.to_bytes((value.bit_length() + 7) // 8, "big"))


def jwks(keys: IdentityKeys) -> dict:
    numbers = keys.jwt_private.public_key().public_numbers()
    return {
        "keys": [
            {
                "kty": "RSA",
                "use": "sig",
                "alg": ALGORITHM,
                "kid": keys.jwt_kid,
                "n": _uint_b64url(numbers.n),
                "e": _uint_b64url(numbers.e),
            }
        ]
    }
