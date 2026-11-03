import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import jwt_tokens
from app.auth import Principal
from app.config import Settings
from app.errors import Unauthenticated
from app.keys import IdentityKeys
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
    keys: IdentityKeys,
    settings: Settings,
) -> str:
    """Consume un desafío MFA, crea la sesión y devuelve su JWT de acceso."""

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

    user, role_name = session.execute(
        select(User, Role.name)
        .join(Role, User.role_id == Role.id)
        .where(User.id == challenge.user_id)
    ).one()
    if not user.is_active:
        raise Unauthenticated("invalid or expired MFA challenge")

    challenge.used_at = now

    # Solo se guarda el hash del ``jti``; el JWT completo no se persiste.
    jti = jwt_tokens.new_jti()
    ttl = settings.session_ttl_seconds

    session.add(
        UserSession(
            token_hash=_hash_token(jti),
            user_id=user.id,
            expires_at=now + timedelta(seconds=ttl),
        )
    )
    session.commit()

    return jwt_tokens.issue_access_token(
        keys,
        user_id=user.id,
        username=user.username,
        role=role_name,
        jti=jti,
        issued_at=int(now.replace(tzinfo=UTC).timestamp()),
        ttl_seconds=ttl,
        issuer=settings.jwt_issuer,
        audience=settings.jwt_audience,
    )


def _claims(token: str, keys: IdentityKeys, settings: Settings) -> jwt_tokens.AccessClaims:
    return jwt_tokens.decode_access_token(
        keys, token, issuer=settings.jwt_issuer, audience=settings.jwt_audience
    )


def revoke_session(session: Session, token: str, *, keys: IdentityKeys, settings: Settings) -> None:
    """Revoca la sesión del JWT. El Gateway lo seguirá aceptando hasta su ``exp``."""
    claims = _claims(token, keys, settings)
    user_session = session.scalar(
        select(UserSession).where(
            UserSession.token_hash == _hash_token(claims.jti),
            UserSession.revoked_at.is_(None),
        )
    )
    if user_session is None:
        raise Unauthenticated("invalid session")

    user_session.revoked_at = _now()
    session.commit()


def principal_from_token(
    session: Session,
    token: str,
    *,
    keys: IdentityKeys,
    settings: Settings,
) -> Principal:
    """Verifica el JWT y que su sesión siga activa (no revocada, usuario activo).

    El rol sale de la base de datos, no del claim, para que un cambio de rol o
    una desactivación tengan efecto inmediato dentro de identidad.
    """
    claims = _claims(token, keys, settings)

    result = session.execute(
        select(UserSession, User, Role.name)
        .join(User, UserSession.user_id == User.id)
        .join(Role, User.role_id == Role.id)
        .where(
            UserSession.token_hash == _hash_token(claims.jti),
            UserSession.user_id == claims.user_id,
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
