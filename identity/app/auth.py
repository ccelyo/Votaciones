"""Autenticación de las peticiones al servicio de identidad."""

from dataclasses import dataclass

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.errors import Forbidden, Unauthenticated


ROLE_ADMIN = "admin"

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
    """Obtiene al usuario desde una sesión real o desde el modo de desarrollo."""

    # Autenticación real mediante Bearer token.
    if credentials is not None:
        token = credentials.credentials.strip()

        if not token:
            raise Unauthenticated("invalid session")

        # Import local para evitar una dependencia circular.
        from app.sessions import principal_from_token

        with request.app.state.session_factory() as session:
            return principal_from_token(session, token)

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


def require_admin(
    principal: Principal = Depends(get_principal),
) -> Principal:
    if ROLE_ADMIN not in principal.roles:
        raise Forbidden("administrator role required")

    return principal