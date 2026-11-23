"""Autenticación y autorización de las peticiones al servicio de identidad.

* ``get_principal``: autentica (401 si no hay sesión válida).
* ``require_permission(p)``: autoriza según ``core/permissions.py`` (403 si el rol no
  tiene ``p``). FastAPI resuelve estas dependencias antes de validar el cuerpo y de
  ejecutar la ruta: una petición denegada solo consulta su sesión y nunca llega a la
  operación protegida.
"""

from collections.abc import Callable
from dataclasses import dataclass

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.errors import Forbidden, Unauthenticated
from app.core.permissions import ROLE_ADMIN, Permission, has_permission

# Declara autenticación Bearer en OpenAPI/Swagger.
bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    user_id: int
    roles: frozenset[str]


def get_principal(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> Principal:
    """Obtiene al usuario desde el JWT de sesión o desde el modo de desarrollo."""

    # Autenticación real: JWT RS256 en la cabecera Bearer.
    if credentials is not None:
        token = credentials.credentials.strip()

        if not token:
            raise Unauthenticated("invalid session")

        # Import local para evitar una dependencia circular.
        from app.services.sessions import principal_from_token

        with request.app.state.session_factory() as session:
            return principal_from_token(
                session,
                token,
                keys=request.app.state.keys,
                settings=request.app.state.settings,
            )

    settings = request.app.state.settings

    # Compatibilidad con el modo de desarrollo usado por M6.
    if settings.dev_auth:
        raw_user = request.headers.get("X-Dev-User", "").strip()

        if not raw_user.isascii() or not raw_user.isdigit() or int(raw_user) <= 0:
            raise Unauthenticated("missing or invalid X-Dev-User header")

        roles = frozenset(
            role.strip()
            for role in request.headers.get("X-Dev-Roles", "").split(",")
            if role.strip()
        )

        return Principal(
            user_id=int(raw_user),
            roles=roles,
        )

    raise Unauthenticated("authentication required")


def require_permission(permission: Permission) -> Callable[..., Principal]:
    """Dependencia que exige ``permission``: ``Depends(require_permission(Permission.X))``."""

    def dependency(principal: Principal = Depends(get_principal)) -> Principal:
        if not has_permission(principal.roles, permission):
            raise Forbidden(f"permission {permission.value!r} required")
        return principal

    dependency.__name__ = f"require_{permission.name.lower()}"
    return dependency


def require_admin(
    principal: Principal = Depends(get_principal),
) -> Principal:
    """Compatibilidad: las rutas de identidad usan ``require_permission``."""
    if ROLE_ADMIN not in principal.roles:
        raise Forbidden("administrator role required")

    return principal