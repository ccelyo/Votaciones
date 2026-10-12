"""Autenticación de las peticiones al servicio de identidad.

La sesión real (login + MFA + roles) es responsabilidad de M5. Este módulo fija el
contrato que mis endpoints consumen: un ``Principal`` con ``user_id`` y ``roles``.
M5 debe reemplazar ``get_principal`` (p. ej. con ``app.dependency_overrides`` o
editando esta función) sin tocar el resto del código.

Mientras tanto existe un modo de desarrollo, desactivado por defecto, que confía
en las cabeceras ``X-Dev-User`` y ``X-Dev-Roles``. No debe activarse en producción.
"""

from dataclasses import dataclass

from fastapi import Depends, Request

from app.errors import Forbidden, Unauthenticated

ROLE_ADMIN = "admin"


@dataclass(frozen=True)
class Principal:
    user_id: str
    roles: frozenset[str]


def get_principal(request: Request) -> Principal:
    settings = request.app.state.settings
    if not settings.dev_auth:
        raise Unauthenticated("session authentication is not configured")

    user_id = request.headers.get("X-Dev-User", "").strip()
    if not user_id or len(user_id) > 64:
        raise Unauthenticated("missing or invalid X-Dev-User header")
    roles = frozenset(
        role.strip() for role in request.headers.get("X-Dev-Roles", "").split(",") if role.strip()
    )
    return Principal(user_id=user_id, roles=roles)


def require_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if ROLE_ADMIN not in principal.roles:
        raise Forbidden("administrator role required")
    return principal
