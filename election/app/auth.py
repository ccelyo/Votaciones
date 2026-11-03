"""Autenticación de las peticiones (FA-04: permisos).

El servicio valida por sí mismo el JWT HS256 de Auth (mismo contrato que el
Gateway, ver gateway/README.md): no confía en las cabeceras ``X-User-*`` porque
cualquiera con acceso a la red interna podría falsificarlas.

* ``sub``: id del usuario. ``roles`` (lista) o ``role`` (texto): ``admin`` administra.
* Con ``ELECTION_DEV_AUTH=true`` y sin token se aceptan ``X-Dev-User`` y
  ``X-Dev-Roles`` (solo desarrollo, igual que identity).
"""

from dataclasses import dataclass

import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import Settings
from app.errors import Forbidden, Unauthenticated

ROLE_ADMIN = "admin"
CLOCK_TOLERANCE_SECONDS = 30

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    user_id: str
    roles: frozenset[str]

    @property
    def is_admin(self) -> bool:
        return ROLE_ADMIN in self.roles


def decode_token(token: str, settings: Settings) -> Principal:
    if not settings.jwt_secret:
        raise Unauthenticated("token authentication is not configured")
    # `sub` puede ser número o texto (contrato del Gateway); PyJWT solo acepta texto.
    options = {
        "require": ["exp", "sub"],
        "verify_aud": bool(settings.jwt_audience),
        "verify_sub": False,
    }
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            audience=settings.jwt_audience or None,
            issuer=settings.jwt_issuer or None,
            leeway=CLOCK_TOLERANCE_SECONDS,
            options=options,
        )
    except jwt.PyJWTError as error:
        raise Unauthenticated("invalid or expired token") from error

    subject = str(claims["sub"]).strip()
    if not subject:
        raise Unauthenticated("token without subject")
    raw_roles = claims.get("roles")
    if isinstance(raw_roles, list):
        roles = frozenset(role for role in raw_roles if isinstance(role, str))
    elif isinstance(claims.get("role"), str):
        roles = frozenset([claims["role"]])
    else:
        roles = frozenset()
    return Principal(user_id=subject[:64], roles=roles)


def _optional_principal(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> Principal | None:
    settings: Settings = request.app.state.settings
    if credentials is not None:
        return decode_token(credentials.credentials.strip(), settings)

    if settings.dev_auth and "X-Dev-User" in request.headers:
        user = request.headers["X-Dev-User"].strip()
        if not user or len(user) > 64:
            raise Unauthenticated("invalid X-Dev-User header")
        roles = frozenset(
            role.strip() for role in request.headers.get("X-Dev-Roles", "").split(",") if role.strip()
        )
        return Principal(user_id=user, roles=roles)
    return None


def optional_principal(principal: Principal | None = Depends(_optional_principal)) -> Principal | None:
    return principal


def get_principal(principal: Principal | None = Depends(_optional_principal)) -> Principal:
    if principal is None:
        raise Unauthenticated("authentication required")
    return principal


def require_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if not principal.is_admin:
        raise Forbidden("administrator role required")
    return principal
