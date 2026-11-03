"""Gestión de usuarios por el administrador: alta, activación y listado.

No hay autoregistro: los votantes los crea un administrador (la inscripción en el
padrón sigue siendo un paso aparte, ``POST /elections/{id}/voters``).
"""

import re

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import InvalidRequest, UserAlreadyExists, UserNotFound
from app.db.models import Role, User
from app.core.security import hash_password

USERNAME_PATTERN = re.compile(r"[A-Za-z0-9._-]{3,100}")
MIN_PASSWORD = 8
MAX_PASSWORD = 128
ROLES = ("admin", "voter")


def create_user(session: Session, *, username: str, password: str, role: str) -> tuple[User, str]:
    if not USERNAME_PATTERN.fullmatch(username):
        raise InvalidRequest("username must be 3 to 100 characters: letters, digits, '.', '_' or '-'")
    if not MIN_PASSWORD <= len(password) <= MAX_PASSWORD:
        raise InvalidRequest(f"password must have between {MIN_PASSWORD} and {MAX_PASSWORD} characters")
    if role not in ROLES:
        raise InvalidRequest(f"role must be one of: {', '.join(ROLES)}")

    role_row = session.scalar(select(Role).where(Role.name == role))
    if role_row is None:
        raise InvalidRequest(f"role {role!r} is not configured")
    if session.scalar(select(User.id).where(User.username == username)) is not None:
        raise UserAlreadyExists()

    user = User(username=username, password_hash=hash_password(password), role_id=role_row.id)
    session.add(user)
    try:
        session.commit()
    except IntegrityError as error:  # carrera con otra alta del mismo username
        session.rollback()
        raise UserAlreadyExists() from error
    return user, role


def set_active(session: Session, *, user_id: int, is_active: bool) -> tuple[User, str]:
    """Desactivar invalida sus sesiones en identidad de inmediato (el Gateway, hasta ``exp``)."""
    result = session.execute(
        select(User, Role.name).join(Role, User.role_id == Role.id).where(User.id == user_id)
    ).first()
    if result is None:
        raise UserNotFound()
    user, role = result
    user.is_active = is_active
    session.commit()
    return user, role
