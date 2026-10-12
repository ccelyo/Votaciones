"""Modelo relacional de la zona de identidad (PostgreSQL).

Mi frente (M6) es `elections` e `issued_tokens`. `voter_roll` es el contrato mínimo
que necesito del padrón; M5 es dueño de usuarios, roles y padrón y puede reemplazar
esa tabla conservando las columnas `user_id` y `election_id`.
"""

from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

STATUS_OPEN = "open"
STATUS_CLOSED = "closed"


class Base(DeclarativeBase):
    pass


class Election(Base):
    """Una urna: una elección con sus parámetros públicos ya firmados."""

    __tablename__ = "elections"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    options: Mapped[list[str]] = mapped_column(JSON)
    encryption_public_key: Mapped[bytes] = mapped_column(LargeBinary)
    opens_at: Mapped[int] = mapped_column(BigInteger)  # epoch, segundos UTC
    closes_at: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(16), default=STATUS_OPEN)

    # Clave pública de verificación de tokens registrada para esta elección.
    token_kid: Mapped[str] = mapped_column(String(64))
    token_public_key_der: Mapped[bytes] = mapped_column(LargeBinary)
    token_variant: Mapped[str] = mapped_column(String(64))

    # Parámetros canónicos firmados por identidad (los descarga el navegador).
    signed_parameters: Mapped[bytes] = mapped_column(LargeBinary)
    parameter_signing_key_id: Mapped[str] = mapped_column(String(64))
    parameter_signature_algorithm: Mapped[str] = mapped_column(String(64))
    parameter_signature: Mapped[bytes] = mapped_column(LargeBinary)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class VoterRollEntry(Base):
    """Padrón: el usuario puede votar en la elección (propiedad de M5)."""

    __tablename__ = "voter_roll"

    # Sin FK a `users` hasta que M5 publique su modelo.
    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    election_id: Mapped[str] = mapped_column(
        ForeignKey("elections.id", ondelete="CASCADE"), primary_key=True
    )


class IssuedToken(Base):
    """Registro de que un usuario ya recibió su token para una elección.

    Identidad conoce ``usuario -> recibió token`` y nada más. Nunca se guarda el
    mensaje cegado ni la firma, para que el token no pueda enlazarse después.
    """

    __tablename__ = "issued_tokens"
    __table_args__ = (
        # Restricción crítica: un token por usuario y elección.
        UniqueConstraint("user_id", "election_id", name="uq_issued_tokens_user_election"),
        Index("ix_issued_tokens_election", "election_id"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    user_id: Mapped[str] = mapped_column(String(64))
    election_id: Mapped[str] = mapped_column(ForeignKey("elections.id"))
    kid: Mapped[str] = mapped_column(String(64))
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
