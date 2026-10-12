import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import Principal
from app.errors import Unauthenticated
from app.models import MFAChallenge, Role, User, UserSession


def _now() -> datetime:
    """Devuelve la hora UTC compatible con TIMESTAMP de PostgreSQL."""
    return datetime.now(UTC).replace(tzinfo=None)


def _hash_token(value: str) -> str:
    """Genera un SHA-256 para no almacenar tokens reales."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def create_mfa_challenge(
    session: Session,
    principal: Principal,
    *,
    ttl_seconds: int,
) -> str:
    """Crea un desafío MFA temporal para el usuario."""

    challenge_id = secrets.token_urlsafe(32)

    challenge = MFAChallenge(
        challenge_hash=_hash_token(challenge_id),
        user_id=principal.user_id,
        expires_at=_now() + timedelta(seconds=ttl_seconds),
    )

    session.add(challenge)
    session.commit()

    return challenge_id


def complete_mfa_challenge(
    session: Session,
    challenge_id: str,
    *,
    session_ttl_seconds: int,
) -> str:
    """Consume un desafío MFA y crea una sesión autenticada."""

    challenge = session.scalar(
        select(MFAChallenge).where(
            MFAChallenge.challenge_hash == _hash_token(challenge_id)
        )
    )

    now = _now()

    if (
        challenge is None
        or challenge.used_at is not None
        or challenge.expires_at <= now
    ):
        raise Unauthenticated("invalid or expired MFA challenge")

    challenge.used_at = now

    token = secrets.token_urlsafe(48)

    user_session = UserSession(
        token_hash=_hash_token(token),
        user_id=challenge.user_id,
        expires_at=now + timedelta(seconds=session_ttl_seconds),
    )

    session.add(user_session)
    session.commit()

    return token


def principal_from_token(
    session: Session,
    token: str,
) -> Principal:
    """Obtiene al usuario asociado con una sesión activa."""

    result = session.execute(
        select(UserSession, User, Role.name)
        .join(User, UserSession.user_id == User.id)
        .join(Role, User.role_id == Role.id)
        .where(
            UserSession.token_hash == _hash_token(token),
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > _now(),
            User.is_active.is_(True),
        )
    ).first()

    if result is None:
        raise Unauthenticated("invalid or expired session")

    _, user, role_name = result

    return Principal(
        user_id=user.id,
        roles=frozenset({role_name}),
    )