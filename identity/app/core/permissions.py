"""Catálogo de permisos y su asignación a roles (RBAC, escenario 5 del Prototipo 3).

Es la ÚNICA fuente de verdad de qué puede hacer cada rol dentro de identidad. Las
rutas no preguntan por el rol, sino por el permiso que necesitan
(``require_permission`` en ``core/auth.py``).

Reglas:

* Deny by default: un rol que no está en ``ROLE_PERMISSIONS`` no recibe ningún permiso,
  y un usuario sin el permiso pedido recibe 403.
* El rol del ``Principal`` sale de la base de datos (``principal_from_token``), no del
  claim del JWT ni de cabeceras del cliente. Por eso este mapa no viaja en el token y
  un cambio aquí tiene efecto inmediato sin reemitir sesiones.
* Cada permiso corresponde a operaciones que existen hoy en ``api/routes.py``.
"""

from collections.abc import Iterable, Mapping
from enum import StrEnum
from types import MappingProxyType


ROLE_ADMIN = "admin"
ROLE_VOTER = "voter"


class Permission(StrEnum):
    # Directorio de usuarios (Auth).
    USERS_READ = "users:read"  # GET /users
    USERS_WRITE = "users:write"  # POST /users, PATCH /users/{id}

    # Padrón electoral (Census).
    CENSUS_READ = "census:read"  # GET /elections/{id}/voters
    CENSUS_WRITE = "census:write"  # POST /elections/{id}/voters, PATCH .../voters/{uid}

    # Ciclo de vida de las urnas.
    ELECTIONS_READ = "elections:read"  # GET /elections, GET /elections/{id}/status
    ELECTIONS_MANAGE = "elections:manage"  # POST /elections, /{id}/open, /{id}/close

    # Participación del propio votante: solo opera sobre el usuario autenticado
    # (parámetros firmados, elegibilidad propia, credencial anónima, confirmación).
    VOTING_PARTICIPATE = "voting:participate"


ROLE_PERMISSIONS: Mapping[str, frozenset[Permission]] = MappingProxyType(
    {
        ROLE_ADMIN: frozenset(
            {
                Permission.USERS_READ,
                Permission.USERS_WRITE,
                Permission.CENSUS_READ,
                Permission.CENSUS_WRITE,
                Permission.ELECTIONS_READ,
                Permission.ELECTIONS_MANAGE,
                # Se conserva el comportamiento previo (un admin inscrito en el padrón
                # puede votar). Quitarlo es una decisión de separación de funciones
                # pendiente del grupo; el padrón y la unicidad de la credencial siguen
                # aplicando igual.
                Permission.VOTING_PARTICIPATE,
            }
        ),
        ROLE_VOTER: frozenset({Permission.VOTING_PARTICIPATE}),
    }
)

# Roles que se pueden asignar a un usuario (``POST /users``).
ROLES: tuple[str, ...] = tuple(ROLE_PERMISSIONS)


def permissions_for(roles: Iterable[str]) -> frozenset[Permission]:
    """Unión de los permisos de los roles; un rol desconocido no aporta ninguno."""
    granted: set[Permission] = set()
    for role in roles:
        granted |= ROLE_PERMISSIONS.get(role, frozenset())
    return frozenset(granted)


def has_permission(roles: Iterable[str], permission: Permission) -> bool:
    return permission in permissions_for(roles)
