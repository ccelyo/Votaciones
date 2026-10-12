"""Modelo relacional de la zona de identidad (PostgreSQL).

La fuente de verdad del esquema es ``identity/schema.sql`` (Kevin). Estos modelos
solo lo reflejan; ``tests/test_schema.py`` falla si dejan de coincidir.

* ``roles`` y ``users``: de M5. Aquí solo existen para resolver las claves foráneas.
* ``elections``, ``voter_roll`` e ``issued_tokens``: esquema de Kevin, usado tal cual.
* ``election_parameters``: tabla nueva (M6) 1 a 1 con ``elections`` para lo que
  `ballot` exige y ``elections`` no guarda: opciones, claves y parámetros firmados.
"""

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

STATUS_DRAFT = "draft"
STATUS_OPEN = "open"
STATUS_CLOSED = "closed"


class Base(DeclarativeBase):
    pass


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(50), unique=True)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(100), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp())


class Election(Base):
    __tablename__ = "elections"
    __table_args__ = (
        CheckConstraint("status IN ('draft', 'open', 'closed')", name="ck_elections_status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(150))
    status: Mapped[str] = mapped_column(String(20), default=STATUS_DRAFT)
    # TIMESTAMP sin zona horaria: se interpretan siempre como UTC.
    starts_at: Mapped[datetime | None] = mapped_column(DateTime)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp())


class ElectionParameters(Base):
    """Parámetros públicos de la urna, ya firmados por identidad."""

    __tablename__ = "election_parameters"

    election_id: Mapped[int] = mapped_column(
        ForeignKey("elections.id", ondelete="CASCADE"), primary_key=True
    )
    options: Mapped[list[str]] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    encryption_public_key: Mapped[bytes] = mapped_column(LargeBinary)

    # Clave pública RSA con la que `ballot` verifica los tokens de esta elección.
    token_kid: Mapped[str] = mapped_column(String(64))
    token_public_key_der: Mapped[bytes] = mapped_column(LargeBinary)
    token_variant: Mapped[str] = mapped_column(String(64))

    # Bytes canónicos y firma que descarga el navegador.
    signed_parameters: Mapped[bytes] = mapped_column(LargeBinary)
    parameter_signing_key_id: Mapped[str] = mapped_column(String(64))
    parameter_signature_algorithm: Mapped[str] = mapped_column(String(64))
    parameter_signature: Mapped[bytes] = mapped_column(LargeBinary)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp())


class VoterRollEntry(Base):
    """Padrón (M5): el usuario puede votar en la elección si ``is_eligible``."""

    __tablename__ = "voter_roll"
    __table_args__ = (
        UniqueConstraint("user_id", "election_id", name="uq_voter_roll_user_election"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    election_id: Mapped[int] = mapped_column(ForeignKey("elections.id"))
    is_eligible: Mapped[bool] = mapped_column(Boolean, default=True)
    has_voted: Mapped[bool] = mapped_column(Boolean, default=False)


class IssuedToken(Base):
    """Registro de que un usuario ya recibió su token para una elección.

    Identidad conoce ``usuario -> recibió token`` y nada más. Nunca se guarda el
    mensaje cegado ni la firma, para que el token no pueda enlazarse después.
    """

    __tablename__ = "issued_tokens"
    __table_args__ = (
        # Restricción crítica: un token por usuario y elección.
        UniqueConstraint("user_id", "election_id", name="uq_issued_tokens_user_election"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    election_id: Mapped[int] = mapped_column(ForeignKey("elections.id"))
    issued_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp())

class MFAChallenge(Base):
    """Desafío temporal requerido para completar el segundo factor."""

    __tablename__ = "mfa_challenges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    challenge_hash: Mapped[str] = mapped_column(
        String(64),
        unique=True,
        nullable=False,
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
    )
    used_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.current_timestamp(),
    )


class UserSession(Base):
    """Sesión autenticada creada después de completar MFA."""

    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(
        String(64),
        unique=True,
        nullable=False,
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.current_timestamp(),
    )