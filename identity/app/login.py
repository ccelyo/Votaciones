from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import Principal
from app.errors import Unauthenticated
from app.models import Role, User
from app.security import verify_password


def authenticate_user(
    session: Session,
    *,
    username: str,
    password: str,
) -> Principal:
    """Valida las credenciales y devuelve la identidad autenticada."""

    result = session.execute(
        select(User, Role.name)
        .join(Role, User.role_id == Role.id)
        .where(User.username == username)
    ).first()

    if result is None:
        raise Unauthenticated("invalid username or password")

    user, role_name = result

    if not user.is_active:
        raise Unauthenticated("invalid username or password")

    if not verify_password(password, user.password_hash):
        raise Unauthenticated("invalid username or password")

    return Principal(
        user_id=user.id,
        roles=frozenset({role_name}),
    )