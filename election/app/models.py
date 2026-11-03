"""Modelo relacional de la base «Elections» (PostgreSQL).

La fuente de verdad del esquema es ``election/schema.sql``; estos modelos solo lo
reflejan y ``tests/test_schema.py`` falla si dejan de coincidir.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

STATUS_DRAFT = "draft"
STATUS_OPEN = "open"
STATUS_CLOSED = "closed"

# BIGSERIAL en PostgreSQL; INTEGER en SQLite para que autoincremente en las pruebas.
BigId = BigInteger().with_variant(Integer, "sqlite")


class UTCDateTime(TypeDecorator):
    """TIMESTAMPTZ que siempre devuelve fechas con zona UTC (también en SQLite)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect):
        if value is not None and value.tzinfo is None:
            raise ValueError("naive datetimes are not allowed; use UTC")
        return value

    def process_result_value(self, value: datetime | None, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class Base(DeclarativeBase):
    pass


class Election(Base):
    __tablename__ = "elections"
    __table_args__ = (
        CheckConstraint("status IN ('draft', 'open', 'closed')", name="ck_elections_status"),
        CheckConstraint("closes_at > opens_at", name="ck_elections_window"),
        CheckConstraint(
            "(status = 'draft' AND opened_at IS NULL AND closed_at IS NULL)"
            " OR (status = 'open' AND opened_at IS NOT NULL AND closed_at IS NULL)"
            " OR (status = 'closed' AND opened_at IS NOT NULL AND closed_at IS NOT NULL)",
            name="ck_elections_lifecycle",
        ),
        Index("ix_elections_status_window", "status", "opens_at", "closes_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(150))
    description: Mapped[str] = mapped_column(String(1000), default="")
    status: Mapped[str] = mapped_column(String(20), default=STATUS_DRAFT)
    opens_at: Mapped[datetime] = mapped_column(UTCDateTime)
    closes_at: Mapped[datetime] = mapped_column(UTCDateTime)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.current_timestamp())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.current_timestamp())
    opened_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    options: Mapped[list["ElectionOption"]] = relationship(
        order_by="ElectionOption.position",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
    )

    @property
    def ref(self) -> str:
        """Identificador externo (texto) de la elección."""
        return str(self.id)

    @property
    def option_labels(self) -> list[str]:
        return [option.label for option in self.options]

    @property
    def blank_option(self) -> str | None:
        return next((option.label for option in self.options if option.is_blank), None)


class ElectionOption(Base):
    __tablename__ = "election_options"
    __table_args__ = (
        UniqueConstraint("election_id", "label", name="uq_election_options_label"),
        CheckConstraint("position >= 0", name="ck_election_options_position"),
        Index(
            "uq_election_options_one_blank",
            "election_id",
            unique=True,
            postgresql_where=text("is_blank"),
            sqlite_where=text("is_blank"),
        ),
    )

    election_id: Mapped[int] = mapped_column(
        ForeignKey("elections.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    label: Mapped[str] = mapped_column(String(128))
    is_blank: Mapped[bool] = mapped_column(Boolean, default=False)


class UrnKey(Base):
    """Par de llaves de la urna. La privada solo existe cifrada (ver app/urn_keys.py)."""

    __tablename__ = "urn_keys"

    election_id: Mapped[int] = mapped_column(
        ForeignKey("elections.id", ondelete="CASCADE"), primary_key=True
    )
    algorithm: Mapped[str] = mapped_column(String(64))
    public_key_der: Mapped[bytes] = mapped_column(LargeBinary)
    wrapped_private_key: Mapped[bytes] = mapped_column(LargeBinary)
    wrap_nonce: Mapped[bytes] = mapped_column(LargeBinary)
    kek_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.current_timestamp())
    released_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    release_count: Mapped[int] = mapped_column(Integer, default=0)


class ElectionParameters(Base):
    """Bytes canónicos de los parámetros públicos y su firma Ed25519."""

    __tablename__ = "election_parameters"

    election_id: Mapped[int] = mapped_column(
        ForeignKey("elections.id", ondelete="CASCADE"), primary_key=True
    )
    signed_parameters: Mapped[bytes] = mapped_column(LargeBinary)
    signing_key_id: Mapped[str] = mapped_column(String(64))
    signature_algorithm: Mapped[str] = mapped_column(String(64))
    signature: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.current_timestamp())


class ElectionAudit(Base):
    __tablename__ = "election_audit"
    __table_args__ = (
        CheckConstraint(
            "action IN ('created', 'updated', 'opened', 'closed', 'urn_key_released')",
            name="ck_election_audit_action",
        ),
        Index("ix_election_audit_election", "election_id", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True)
    election_id: Mapped[int] = mapped_column(ForeignKey("elections.id", ondelete="CASCADE"))
    action: Mapped[str] = mapped_column(String(32))
    actor: Mapped[str] = mapped_column(String(64))
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.current_timestamp())


class OutboxEvent(Base):
    """Evento de ``election.events`` pendiente o ya publicado (app/events.py)."""

    __tablename__ = "outbox_events"

    id: Mapped[int] = mapped_column(BigId, primary_key=True)
    event_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True)
    event_type: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.current_timestamp())
    published_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(String(500))
